import { spawnSync } from 'node:child_process';

/**
 * Runs git read-only in a repo. GIT_OPTIONAL_LOCKS=0 stops commands like `status` from refreshing
 * the index, so the repo being demoed is never written to (PRD D3).
 */
export function git(repo: string, args: string[], input?: Buffer | string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Like `git`, but throws with git's own message on failure and returns trimmed stdout. */
export function gitOut(repo: string, args: string[]): string {
  const r = git(repo, args);
  if (!r.ok) throw new Error(r.stderr.trim() || `git ${args.join(' ')} failed`);
  return r.stdout.trim();
}

/** The full sha of a commit-ish, or undefined when it isn't one. */
export function resolveCommit(repo: string, rev: string): string | undefined {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  return r.ok ? r.stdout.trim() : undefined;
}

export function refExists(repo: string, ref: string): boolean {
  return git(repo, ['show-ref', '--verify', '--quiet', ref]).ok;
}
