import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Change } from './change.ts';
import type { Config } from './config.ts';
import { contextParts, renderContext } from './context.ts';
import { parsePatch, type FileDiff } from './diff.ts';
import { git, gitOut } from './git.ts';
import { areaOf } from './glob.ts';
import { repoCache, runDir, srcDir } from './paths.ts';
import { elideTests } from './swift.ts';

export type Prepared = {
  repo: string;
  repoName: string;
  change: Change;
  src: string;
  run: string;
  files: (FileDiff & { area: string | null })[];
  uiFiles: string[];
  contextBytes: number;
  cut: string[];
};

const diffArgs = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

function sh(script: string, args: string[], input?: string): void {
  const r = spawnSync('bash', ['-o', 'pipefail', '-c', script, 'sh', ...args], {
    input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', COPYFILE_DISABLE: '1' },
  });
  if (r.status !== 0) throw new Error(`${script.split(' ')[0]} failed: ${(r.stderr ?? '').trim()}`);
}

/** The change's head tree, written to `dest`: `git archive` for a commit, the tracked and untracked files for the working tree. */
function exportTree(repo: string, change: Change, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (change.head !== 'worktree') {
    sh('git -C "$1" archive "$2" | tar -x -f - -C "$3"', [repo, change.head, dest]);
    return;
  }
  const listed = gitOut(repo, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  // A tracked file deleted in the working tree is still listed; a submodule is a folder.
  const files = listed.filter((p) => {
    try {
      const st = lstatSync(join(repo, p));
      return st.isFile() || st.isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (files.length) sh('tar -c --no-recursion --no-mac-metadata -f - -C "$1" --null -T - | tar -x -f - -C "$2"', [repo, dest], files.join('\0') + '\0');
}

/**
 * Brings the stable src/ in line with the export. Only files whose contents differ are copied,
 * and they get the current time, so the build sees exactly what changed; the rest keep their dates.
 */
function sync(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  // The web driver installs dependencies into the export; --delete leaves an excluded folder alone.
  const r = spawnSync('rsync', ['-rlp', '--checksum', '--delete', '--exclude', '/node_modules/', `${from}/`, `${to}/`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`rsync failed: ${r.stderr.trim()}`);
}

/** The change as a patch. For the working tree: tracked changes against HEAD, then each untracked file. */
function patchOf(repo: string, change: Change): string {
  const tracked = git(repo, [...diffArgs, change.base, ...(change.head === 'worktree' ? [] : [change.head])]);
  if (!tracked.ok) throw new Error(`git diff failed: ${tracked.stderr.trim()}`);
  if (change.head !== 'worktree') return tracked.stdout;
  let patch = tracked.stdout;
  const untracked = gitOut(repo, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  for (const path of untracked) {
    const r = git(repo, [...diffArgs, '--no-index', '--', '/dev/null', path]);
    patch += r.stdout;
  }
  return patch;
}

function messagesOf(repo: string, change: Change): { sha: string; message: string }[] {
  return change.commits.map(({ sha }) => ({ sha, message: gitOut(repo, ['log', '-1', '--format=%B', sha]) }));
}

/** Exports the change's tree into the repo's stable src/ and returns its path. */
export function syncSource(repo: string, change: Change): string {
  const repoName = basename(repo);
  const src = srcDir(repoName);
  const tmp = join(repoCache(repoName), 'export.tmp');
  exportTree(repo, change, tmp);
  sync(tmp, src);
  rmSync(tmp, { recursive: true, force: true });
  return src;
}

/** Exports the change into src/ and writes the run directory: run.json, diff.patch, changes.json, context.md. */
export function prepare(repoArg: string, change: Change, config: Config): Prepared {
  const repo = gitOut(repoArg, ['rev-parse', '--show-toplevel']);
  const repoName = basename(repo);
  const run = runDir(repoName, change.id);
  const src = syncSource(repo, change);

  const patch = patchOf(repo, change);
  const files = parsePatch(patch).map((f) => ({ ...f, area: areaOf(f.path, config.areas) }));
  const hasUiArea = 'ui' in config.areas;
  const uiFiles = files
    .filter((f) => f.status !== 'deleted' && !f.binary && (!hasUiArea || f.area === 'ui') && existsSync(join(src, f.path)))
    .map((f) => ({ path: f.path, source: readFileSync(join(src, f.path), 'utf8') }));

  let helpers;
  if (config.platform === 'ios' && existsSync(join(src, config.injectInto))) {
    const touched = new Set(files.find((f) => f.path === config.injectInto)?.addedLines);
    helpers = { path: config.injectInto, ...elideTests(readFileSync(join(src, config.injectInto), 'utf8'), touched) };
  }

  const parts = contextParts({ change, config, messages: messagesOf(repo, change), files, uiFiles, helpers, src, run });
  const context = renderContext(parts, src);

  mkdirSync(run, { recursive: true });
  const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
  writeFileSync(join(run, 'run.json'), json({ repo, repoName, config: config.file, src, change }));
  writeFileSync(join(run, 'diff.patch'), patch);
  writeFileSync(join(run, 'changes.json'), json({
    base: change.base, head: change.head,
    files: files.map(({ path, from, status, area, binary, added, removed }) => ({ path, ...(from !== undefined && { from }), status, area, binary, added, removed })),
  }));
  writeFileSync(join(run, 'context.md'), context.text);

  return { repo, repoName, change, src, run, files, uiFiles: uiFiles.map((f) => f.path), contextBytes: Buffer.byteLength(context.text), cut: context.cut };
}
