// Puts a rendered GIF in its pull request (PRD §3.3): the GIF is committed to the PR's head repo
// on GitHub through the Git data API, under a ref `git clone` doesn't fetch, and linked from a
// marked section of the PR description. Everything goes through `gh`, never the local clone, and
// `gh` never runs inside the repo (it can write `gh-resolved` to its .git/config): the repo on
// GitHub comes from its remote's URL and every call names it with --repo.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';
import { moviesDir } from './paths.ts';

/** Runs `gh` with these arguments (and stdin); a missing gh is a failed result. */
export type Gh = (args: string[], input?: string) => { ok: boolean; stdout: string; stderr: string };

export const startMarker = '<!-- doomship -->';
export const endMarker = '<!-- /doomship -->';
/** Where "made with doomship" links (your notes, 2026-10-15). */
export const doomshipUrl = 'https://github.com/sudonicolas/doomship';
/** The GIF's width in the PR: half its pixels, so it's sharp on a retina screen (300 for a phone's 600). */
export const shownWidth = (gifWidth?: number) => Math.round((gifWidth ?? 600) / 2);

export type Slug = { owner: string; name: string };
export const slugText = (s: Slug) => `${s.owner}/${s.name}`;

/** owner/name from a GitHub remote URL (https, ssh or scp-like). */
export function parseGitHubUrl(url: string): Slug | undefined {
  const m = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], name: m[2] } : undefined;
}

/** The repo on GitHub that a local clone came from: its origin, read without writing anything. */
export function githubRepoOf(repo: string): Slug {
  const r = git(repo, ['remote', 'get-url', 'origin']);
  const slug = r.ok ? parseGitHubUrl(r.stdout) : undefined;
  if (!slug) throw new Error(`${repo}: its origin isn't on GitHub (${r.stdout.trim() || r.stderr.trim()}), so there's no PR to post to`);
  return slug;
}

/** What a render's sidecar JSON says (render/index.ts). */
export type Sidecar = {
  commit: string; worktree: boolean; title: string; captions: string[];
  duration: number; bytes: number; width?: number; files: { gif: string; png: string };
};
export type Found = Sidecar & { gif: string; json: string };

/** The newest render of this commit (not of a working tree on it), or undefined. */
export function newestRender(repoName: string, sha: string): Found | undefined {
  const dir = moviesDir(repoName);
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))
    .map((json) => {
      try {
        return { json, side: JSON.parse(readFileSync(json, 'utf8')) as Sidecar, at: statSync(json).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.side.commit === sha && !x.side.worktree && !!x.side.files?.gif && existsSync(join(dir, x.side.files.gif)))
    .sort((a, b) => b.at - a.at)
    .map(({ json, side }) => ({ ...side, json, gif: join(dir, side.files.gif) }))[0];
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The section that goes in the PR description. */
export function section(o: { url: string; captions: string[]; sha: string; width?: number }): string {
  const alt = o.captions.length ? o.captions.join('. ') : 'A GIF of the change';
  return [
    startMarker,
    `<img src="${attr(o.url)}" width="${shownWidth(o.width)}" alt="${attr(alt)}">`,
    '',
    `<sub>${o.sha.slice(0, 7)} · made with <a href="${doomshipUrl}">doomship</a></sub>`,
    endMarker,
  ].join('\n');
}

/** The description with the section in place of the old one, or at the top; nothing else changes. */
export function withSection(body: string, sec: string): string {
  const a = body.indexOf(startMarker);
  const b = a === -1 ? -1 : body.indexOf(endMarker, a);
  if (a !== -1 && b !== -1) return body.slice(0, a) + sec + body.slice(b + endMarker.length);
  return body.trim() ? `${sec}\n\n${body}` : sec;
}

export type Pr = { number: number; url: string; body: string; head: string; headRepo: Slug };

function ghJson<T>(gh: Gh, args: string[], input?: string): T {
  const r = gh(args, input);
  if (!r.ok) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout) as T;
}

/** The PR: its description, head commit and the repo that head lives in (a fork, for a contributor). */
export function readPr(gh: Gh, repo: Slug, pr: string): Pr {
  type View = { number: number; url: string; body: string; headRefOid: string;
    headRepository?: { name: string } | null; headRepositoryOwner?: { login: string } | null };
  const v = ghJson<View>(gh, ['pr', 'view', pr, '--repo', slugText(repo), '--json', 'number,url,body,headRefOid,headRepository,headRepositoryOwner']);
  const headRepo = v.headRepository && v.headRepositoryOwner ? { owner: v.headRepositoryOwner.login, name: v.headRepository.name } : repo;
  return { number: v.number, url: v.url, body: v.body ?? '', head: v.headRefOid, headRepo };
}

/** The ref a GIF is kept under: outside heads and tags, so clones and the branch list don't see it. */
export const mediaRef = (sha: string) => `refs/doomship/${sha}`;

/**
 * Commits the GIF, alone, to the head repo under refs/doomship/<sha> (replacing what was there)
 * and returns the URL GitHub serves it at, with the same access as the repo's code.
 */
export function upload(gh: Gh, to: Slug, sha: string, gif: string, name: string): string {
  const api = (method: string, path: string, body: object) =>
    ghJson<{ sha?: string; object?: { sha: string } }>(gh, ['api', '-X', method, `repos/${slugText(to)}/${path}`, '--input', '-'], JSON.stringify(body));
  const blob = api('POST', 'git/blobs', { content: readFileSync(gif).toString('base64'), encoding: 'base64' }).sha!;
  const tree = api('POST', 'git/trees', { tree: [{ path: name, mode: '100644', type: 'blob', sha: blob }] }).sha!;
  const commit = api('POST', 'git/commits', { message: `doomship: ${sha.slice(0, 7)}`, tree, parents: [] }).sha!;
  const ref = mediaRef(sha);
  const exists = gh(['api', `repos/${slugText(to)}/git/ref/${ref.replace(/^refs\//, '')}`]).ok;
  if (exists) api('PATCH', `git/${ref}`, { sha: commit, force: true });
  else api('POST', 'git/refs', { ref, sha: commit });
  return `https://github.com/${slugText(to)}/blob/${commit}/${encodeURIComponent(name)}?raw=true`;
}

export type Posted = { pr: Pr; render: Found; section: string; body: string; url?: string };

/**
 * Finds the newest render of the PR's head and puts it in the PR. With dryRun, uploads nothing
 * and edits nothing: the section (with a placeholder URL) and the new description come back.
 */
export function post(gh: Gh, repo: string, repoName: string, prArg: string, opts: { dryRun?: boolean } = {}): Posted {
  const pr = readPr(gh, githubRepoOf(repo), prArg);
  const render = newestRender(repoName, pr.head);
  if (!render) {
    throw new Error(`no GIF of the PR's head (${pr.head.slice(0, 7)}) in ${moviesDir(repoName)}: make one first, ` +
      `for example /doomship ${repo} <base>..${pr.head.slice(0, 7)}`);
  }
  const name = `${pr.head.slice(0, 7)}.gif`;
  const url = opts.dryRun
    ? `https://github.com/${slugText(pr.headRepo)}/blob/COMMIT/${name}?raw=true`
    : upload(gh, pr.headRepo, pr.head, render.gif, name);
  const sec = section({ url, captions: render.captions, sha: pr.head, width: render.width });
  const body = withSection(pr.body, sec);
  if (!opts.dryRun) {
    const r = gh(['pr', 'edit', String(pr.number), '--repo', slugText(githubRepoOf(repo)), '--body-file', '-'], body);
    if (!r.ok) throw new Error(`gh pr edit failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return { pr, render, section: sec, body, ...(opts.dryRun ? {} : { url }) };
}
