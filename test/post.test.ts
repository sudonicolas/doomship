import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doomshipUrl, endMarker, parseGitHubUrl, post, section, startMarker, withSection, type Gh } from '../src/post.ts';

test('parseGitHubUrl: https, ssh and scp-like remotes', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/you/app.git'), { owner: 'you', name: 'app' });
  assert.deepEqual(parseGitHubUrl('git@github.com:a/b.git\n'), { owner: 'a', name: 'b' });
  assert.deepEqual(parseGitHubUrl('ssh://git@github.com/a/b'), { owner: 'a', name: 'b' });
  assert.equal(parseGitHubUrl('https://gitlab.com/a/b.git'), undefined);
});

test('section: the GIF at 300 px, captions as alt text, the short sha and a link to doomship', () => {
  const s = section({ url: 'https://github.com/a/b/blob/c0ffee/abc1234.gif?raw=true', captions: ['Pick the days', 'Say "when"'], sha: 'abc1234def' });
  assert.ok(s.startsWith(startMarker) && s.endsWith(endMarker));
  assert.match(s, /<img src="https:\/\/github\.com\/a\/b\/blob\/c0ffee\/abc1234\.gif\?raw=true" width="300" alt="Pick the days\. Say &quot;when&quot;">/);
  assert.ok(s.includes(`abc1234 · made with <a href="${doomshipUrl}">doomship</a>`));
  assert.ok(!s.includes('—'));
  // A desktop GIF (960 px) shows at half its width too, so its screen stays readable.
  assert.match(section({ url: 'u', captions: [], sha: 'abc1234', width: 960 }), /width="480"/);
});

test('withSection: at the top the first time, in place after that; the rest of the description untouched', () => {
  const one = section({ url: 'u1', captions: ['a'], sha: '1111111' });
  const two = section({ url: 'u2', captions: ['b'], sha: '2222222' });
  const body = 'Fixes the thing.\n\n- [x] tested\n';
  const first = withSection(body, one);
  assert.equal(first, `${one}\n\n${body}`);
  const second = withSection(first, two);
  assert.equal(second, `${two}\n\n${body}`);
  assert.equal(second.split(startMarker).length, 2);
  // Text someone added around the section stays where it is.
  const edited = `Above\n${one}\nBelow`;
  assert.equal(withSection(edited, two), `Above\n${two}\nBelow`);
  assert.equal(withSection('', one), one);
});

/** A local repo with a GitHub origin, a movies folder with renders, and a fake gh that logs its calls. */
function fixture(prJson: object) {
  const root = mkdtempSync(join(tmpdir(), 'doomship-post-'));
  const repo = join(root, 'app');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:team/app.git']);
  const movies = join(root, 'movies');
  mkdirSync(join(movies, 'app'), { recursive: true });
  process.env.DOOMSHIP_MOVIES = movies;
  const render = (name: string, commit: string, captions: string[], worktree = false, age = 0) => {
    writeFileSync(join(movies, 'app', `${name}.gif`), `GIF of ${name}`);
    const json = join(movies, 'app', `${name}.json`);
    writeFileSync(json, JSON.stringify({ commit, worktree, title: name, captions, duration: 9, bytes: 10, files: { gif: `${name}.gif`, png: `${name}.png` } }));
    const t = Date.now() / 1000 - age;
    utimesSync(json, t, t);
  };
  const calls: { args: string[]; input?: string }[] = [];
  let sha = 0;
  const gh: Gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'pr' && args[1] === 'view') return { ok: true, stdout: JSON.stringify(prJson), stderr: '' };
    if (args[0] === 'api' && args.length === 2) return { ok: false, stdout: '', stderr: 'Not Found' }; // no ref yet
    if (args[0] === 'api') return { ok: true, stdout: JSON.stringify({ sha: `sha${++sha}` }), stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  return { repo, render, calls, gh, gitConfig: () => readFileSync(join(repo, '.git', 'config'), 'utf8') };
}

const head = 'abcdef0123456789abcdef0123456789abcdef01';
const pr = { number: 7, url: 'https://github.com/team/app/pull/7', body: 'Adds training days.', headRefOid: head,
  headRepository: { name: 'app' }, headRepositoryOwner: { login: 'team' } };

test('post --dry-run: finds the newest render of the PR head and changes nothing', () => {
  const f = fixture(pr);
  f.render('old', head, ['Old'], false, 100);
  f.render('wt', head, ['Working tree'], true);
  f.render('other', '0'.repeat(40), ['Other']);
  f.render('new', head, ['Pick the days you can train']);
  const config = f.gitConfig();
  const p = post(f.gh, f.repo, 'app', '7', { dryRun: true });
  assert.ok(p.render.gif.endsWith('new.gif'));
  assert.match(p.section, /alt="Pick the days you can train"/);
  assert.match(p.section, /blob\/COMMIT\/abcdef0\.gif/);
  assert.deepEqual(f.calls.map((c) => c.args.slice(0, 2)), [['pr', 'view']]);
  assert.deepEqual(f.calls[0].args.slice(2), ['7', '--repo', 'team/app', '--json', 'number,url,body,headRefOid,headRepository,headRepositoryOwner']);
  assert.equal(f.gitConfig(), config, 'the local clone is never written to');
});

test('post: commits the GIF under refs/doomship/<sha> and edits only the section into the description', () => {
  const f = fixture(pr);
  f.render('new', head, ['Pick the days you can train']);
  const p = post(f.gh, f.repo, 'app', '7');
  const api = f.calls.filter((c) => c.args[0] === 'api').map((c) => c.args.slice(0, 4).join(' '));
  assert.deepEqual(api, [
    'api -X POST repos/team/app/git/blobs',
    'api -X POST repos/team/app/git/trees',
    'api -X POST repos/team/app/git/commits',
    'api repos/team/app/git/ref/doomship/' + head,
    'api -X POST repos/team/app/git/refs',
  ]);
  const blob = JSON.parse(f.calls.find((c) => c.args[3]?.endsWith('git/blobs'))!.input!);
  assert.equal(Buffer.from(blob.content, 'base64').toString(), 'GIF of new');
  const commit = JSON.parse(f.calls.find((c) => c.args[3]?.endsWith('git/commits'))!.input!);
  assert.deepEqual(commit.parents, [], 'a commit of its own, not on any branch');
  assert.deepEqual(JSON.parse(f.calls.at(-2)!.input!), { ref: `refs/doomship/${head}`, sha: 'sha3' });
  assert.equal(p.url, 'https://github.com/team/app/blob/sha3/abcdef0.gif?raw=true');
  const edit = f.calls.at(-1)!;
  assert.deepEqual(edit.args, ['pr', 'edit', '7', '--repo', 'team/app', '--body-file', '-']);
  assert.equal(edit.input, `${p.section}\n\nAdds training days.`);
});

test('post: a PR from a fork hosts the GIF in the fork and edits the PR upstream', () => {
  const f = fixture({ ...pr, headRepository: { name: 'app-fork' }, headRepositoryOwner: { login: 'contributor' } });
  f.render('new', head, ['A caption']);
  post(f.gh, f.repo, 'app', '7');
  const targets = new Set(f.calls.filter((c) => c.args[0] === 'api').map((c) => c.args.find((a) => a.startsWith('repos/'))!.split('/').slice(1, 3).join('/')));
  assert.deepEqual([...targets], ['contributor/app-fork']);
  assert.deepEqual(f.calls.at(-1)!.args.slice(0, 5), ['pr', 'edit', '7', '--repo', 'team/app']);
});

test('post: no render of the PR head says what to do', () => {
  const f = fixture(pr);
  f.render('other', '0'.repeat(40), ['Other']);
  assert.throws(() => post(f.gh, f.repo, 'app', '7', { dryRun: true }), /no GIF of the PR's head \(abcdef0\).*\/doomship/);
});
