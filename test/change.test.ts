import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyTree, resolveChange, slug } from '../src/change.ts';

/** A repo: main has root, "Add a button"; feature (off "Add a button") has two more; main moves on once. */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'doomship-change-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = (file: string, subject: string) => {
    writeFileSync(join(repo, file), subject);
    g('add', file);
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', subject);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'main');
  const root = commit('a.txt', 'Root');
  const button = commit('b.txt', 'Add a button');
  g('checkout', '-q', '-b', 'feature/coach-invite');
  const f1 = commit('c.txt', 'Invite a coach');
  const f2 = commit('d.txt', 'Coach invite copy');
  g('checkout', '-q', 'main');
  const m3 = commit('e.txt', 'Unrelated on main');
  return { repo, g, root, button, f1, f2, m3 };
}

test('a sha is that commit against its parent', () => {
  const { repo, root, button } = fixture();
  const c = resolveChange(repo, button.slice(0, 8));
  assert.equal(c.kind, 'commit');
  assert.equal(c.base, root);
  assert.equal(c.head, button);
  assert.equal(c.id, button.slice(0, 7));
  assert.equal(c.title, 'Add a button');
  assert.deepEqual(c.commits, [{ sha: button, subject: 'Add a button' }]);
});

test('a root commit is against the empty tree', () => {
  const { repo, root } = fixture();
  const c = resolveChange(repo, root);
  assert.equal(c.base, emptyTree);
  assert.equal(c.title, 'Root');
});

test('a..b is b against a; a...b is b against their merge-base', () => {
  const { repo, root, button, f2, m3 } = fixture();
  const c = resolveChange(repo, `${root}..${f2}`);
  assert.equal(c.kind, 'range');
  assert.equal(c.base, root);
  assert.equal(c.head, f2);
  assert.equal(c.commits.length, 3);
  assert.equal(c.title, 'Coach invite copy and 2 more');
  assert.equal(c.id, `${root.slice(0, 7)}-${f2.slice(0, 7)}`);

  const sym = resolveChange(repo, `${m3}...${f2}`);
  assert.equal(sym.base, button);
  assert.equal(sym.commits.length, 2);
});

test('a one-commit range is titled by that commit', () => {
  const { repo, f1, f2 } = fixture();
  assert.equal(resolveChange(repo, `${f1}..${f2}`).title, 'Coach invite copy');
});

test('a branch is its tip against its merge-base with main', () => {
  const { repo, button, f1, f2 } = fixture();
  const c = resolveChange(repo, 'feature/coach-invite');
  assert.equal(c.kind, 'branch');
  assert.equal(c.base, button);
  assert.equal(c.head, f2);
  assert.deepEqual(c.commits.map((x) => x.sha), [f1, f2]);
  assert.equal(c.title, 'feature/coach-invite');
  assert.equal(c.id, `feature-coach-invite-${f2.slice(0, 7)}`);
});

test('the working tree is against HEAD', () => {
  const { repo, m3 } = fixture();
  const c = resolveChange(repo, undefined);
  assert.equal(c.kind, 'worktree');
  assert.equal(c.base, m3);
  assert.equal(c.head, 'worktree');
  assert.equal(c.headCommit, m3);
  assert.equal(c.id, `worktree-${m3.slice(0, 7)}`);
  assert.equal(c.title, 'Uncommitted changes on main');
});

test('the same change always has the same id', () => {
  const { repo, f2 } = fixture();
  assert.equal(resolveChange(repo, f2).id, resolveChange(repo, f2.slice(0, 10)).id);
});

test('bad changes are explained', () => {
  const { repo, f2 } = fixture();
  assert.throws(() => resolveChange(repo, 'nope'), /nope: not a commit, range or branch/);
  assert.throws(() => resolveChange(repo, `${f2}..nope`), /nope: not a commit/);
  assert.throws(() => resolveChange(repo, `${f2}..${f2}`), /no commits in this range/);
  assert.throws(() => resolveChange(repo, 'main'), /it is the main branch/);
});

test('the repo is not written to', () => {
  const { repo, g, f2 } = fixture();
  const before = g('status', '--porcelain=v2', '--branch');
  resolveChange(repo, 'feature/coach-invite');
  resolveChange(repo, f2);
  resolveChange(repo, undefined);
  assert.equal(g('status', '--porcelain=v2', '--branch'), before);
});

test('slug makes short file-safe names', () => {
  assert.equal(slug('4.4b Availability in Settings'), '4-4b-availability-in-settings');
  assert.equal(slug('Rate how you’re arriving!'), 'rate-how-you-re-arriving');
  assert.equal(slug('a very long title that keeps going and going on', 20), 'a-very-long-title');
});
