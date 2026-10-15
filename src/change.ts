import { git, gitOut, refExists, resolveCommit } from './git.ts';

/** What one GIF shows: the difference between two trees of a repo. */
export type Change = {
  kind: 'commit' | 'range' | 'branch' | 'worktree';
  /** What was asked for: a sha, `a..b`, a branch name, or "--worktree". */
  spec: string;
  /** The full sha the change starts from. */
  base: string;
  /** The full sha it ends at, or "worktree" for uncommitted changes. */
  head: string;
  /** The commit the head tree is (or, for the working tree, sits on). */
  headCommit: string;
  /** Oldest first: the commits in base..head. Empty for the working tree. */
  commits: { sha: string; subject: string }[];
  /** The run directory's name: stable, so the same change always lands in the same run. */
  id: string;
  title: string;
};

/** git's empty tree: the base of a root commit. */
export const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const short = (sha: string) => sha.slice(0, 7);

/** Lowercase words joined by hyphens, at most `max` characters, for file and folder names. */
export function slug(text: string, max = 40): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length <= max ? s : s.slice(0, max).replace(/-[^-]*$/, '') || s.slice(0, max);
}

/** The repo's main branch: `main`, else `master`, else what origin/HEAD points at. */
export function mainBranch(repo: string): string {
  for (const name of ['main', 'master']) if (refExists(repo, `refs/heads/${name}`)) return name;
  const r = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  throw new Error('no main branch: the repo has neither "main" nor "master"; name a range instead (a..b)');
}

function commitsBetween(repo: string, base: string, head: string): Change['commits'] {
  const range = base === emptyTree ? head : `${base}..${head}`;
  const out = gitOut(repo, ['log', '--reverse', '--format=%H %s', range]);
  return out ? out.split('\n').map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })) : [];
}

function rangeTitle(commits: Change['commits']): string {
  const last = commits.at(-1)!;
  return commits.length === 1 ? last.subject : `${last.subject} and ${commits.length - 1} more`;
}

/**
 * Turns what the user typed into a change:
 * - `<sha>` (any commit-ish that isn't a branch): that commit against its parent.
 * - `a..b`: b against a. `a...b`: b against their merge-base.
 * - a branch: its tip against its merge-base with the main branch.
 * - `--worktree` (spec undefined): the working tree, untracked files included, against HEAD.
 */
export function resolveChange(repo: string, spec: string | undefined): Change {
  if (spec === undefined) {
    const headCommit = resolveCommit(repo, 'HEAD');
    if (!headCommit) throw new Error('the working tree has no commit to compare with (no HEAD yet)');
    const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
    return {
      kind: 'worktree', spec: '--worktree', base: headCommit, head: 'worktree', headCommit, commits: [],
      id: `worktree-${short(headCommit)}`,
      title: branch ? `Uncommitted changes on ${branch}` : `Uncommitted changes on ${short(headCommit)}`,
    };
  }

  const range = spec.match(/^(.*?)(\.\.\.?)(.*)$/);
  if (range) {
    const [, a, dots, b] = range;
    const aSha = resolveCommit(repo, a || 'HEAD');
    const head = resolveCommit(repo, b || 'HEAD');
    if (!aSha) throw new Error(`${a}: not a commit in this repo`);
    if (!head) throw new Error(`${b}: not a commit in this repo`);
    const base = dots === '...' ? gitOut(repo, ['merge-base', aSha, head]) : aSha;
    const commits = commitsBetween(repo, base, head);
    if (!commits.length) throw new Error(`${spec}: no commits in this range`);
    return { kind: 'range', spec, base, head, headCommit: head, commits, id: `${short(base)}-${short(head)}`, title: rangeTitle(commits) };
  }

  const branchRef = [`refs/heads/${spec}`, `refs/remotes/${spec}`].find((r) => refExists(repo, r));
  if (branchRef) {
    const head = resolveCommit(repo, branchRef)!;
    const main = mainBranch(repo);
    const base = gitOut(repo, ['merge-base', main, head]);
    const commits = commitsBetween(repo, base, head);
    if (!commits.length) {
      throw new Error(`${spec}: no commits since it left ${main}${spec === main ? ` (it is the main branch; name a commit or a range)` : ''}`);
    }
    const name = spec.replace(/^origin\//, '');
    return { kind: 'branch', spec, base, head, headCommit: head, commits, id: `${slug(name, 30)}-${short(head)}`, title: commits.length === 1 ? commits[0].subject : name };
  }

  const head = resolveCommit(repo, spec);
  if (!head) throw new Error(`${spec}: not a commit, range or branch in this repo`);
  const parent = resolveCommit(repo, `${head}^`);
  const base = parent ?? emptyTree;
  const commits = commitsBetween(repo, base, head);
  const title = gitOut(repo, ['log', '-1', '--format=%s', head]);
  return { kind: 'commit', spec, base, head, headCommit: head, commits, id: short(head), title };
}
