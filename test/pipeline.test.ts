import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptsOf, skipRun, summary } from '../src/pipeline.ts';
import type { Run } from '../src/run.ts';

const run = {
  dir: '/runs/89cd1d6', repo: '/r', repoName: 'r', src: '/src',
  change: { kind: 'commit', spec: '89cd1d6', base: 'a', head: 'b', headCommit: 'b', commits: [], id: '89cd1d6', title: 'First run: welcome and profile' },
  config: { platform: 'ios' },
} as unknown as Run;

test('summary: title, path, length, size, attempts and times', () => {
  const g = { gif: '/m/x.gif', png: '', json: '', duration: 11.27, bytes: 1908823, width: 600, height: 1432, fps: 15, captions: ['a', 'b', 'c'], seconds: 1.12 };
  const attempts = [
    { buildSeconds: 2.1, outcome: 'build failed' as const, failure: 'x' },
    { buildSeconds: 6.81, recordSeconds: 19.33, outcome: 'recorded' as const },
  ];
  assert.equal(summary(run, attempts, g), [
    'First run: welcome and profile',
    '  gif:      /m/x.gif',
    '  length:   11.3 s, 3 captions',
    '  size:     1.8 MB, 600×1432 at 15 fps',
    '  attempts: 2',
    '  times:    build 6.8 s, record 19.3 s, render 1.1 s',
  ].join('\n'));
});

test('skip writes the reason and drops any demo; attempts are read back in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doomship-run-'));
  const r = { ...run, dir };
  writeFileSync(join(dir, 'demo.swift'), 'x');
  assert.throws(() => skipRun(r, '  '), /needs a reason/);
  skipRun(r, 'Only the preset data model changed; nothing on screen.');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'skip.json'), 'utf8')), {
    change: '89cd1d6', title: 'First run: welcome and profile', reason: 'Only the preset data model changed; nothing on screen.',
  });
  assert.equal(existsSync(join(dir, 'demo.swift')), false);
  assert.deepEqual(attemptsOf(r), []);
  writeFileSync(join(dir, 'attempts.jsonl'), '{"buildSeconds":1,"outcome":"build failed"}\n{"buildSeconds":2,"outcome":"recorded"}\n');
  assert.deepEqual(attemptsOf(r).map((a) => a.outcome), ['build failed', 'recorded']);
});

test('run without a demo prepares and says what to do next; a skipped run says so', () => {
  const repo = mkdtempSync(join(tmpdir(), 'doomship-run-repo-'));
  const env = { ...process.env, DOOMSHIP_CACHE: mkdtempSync(join(tmpdir(), 'doomship-cache-')) };
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  g('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'AppUITests'));
  writeFileSync(join(repo, 'AppUITests/AppUITests.swift'), 'import XCTest\n');
  writeFileSync(join(repo, '.doomship.json'), JSON.stringify({ platform: 'ios', project: 'App.xcodeproj', scheme: 'App', uiTestTarget: 'AppUITests', injectInto: 'AppUITests/AppUITests.swift' }));
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Root');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const doomship = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  const first = doomship('run', repo, 'HEAD');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /No demo yet: write demo\.swift there and run again, or: doomship skip .* --reason/);
  const runDir = join(env.DOOMSHIP_CACHE, repo.split('/').pop()!, 'runs', g('rev-parse', '--short=7', 'HEAD').toString().trim());
  assert.equal(doomship('skip', runDir).status, 64);
  assert.equal(doomship('skip', runDir, '--reason', 'Nothing on screen.').status, 0);
  const again = doomship('run', repo, 'HEAD');
  assert.match(again.stdout, /^Skipped [0-9a-f]{7}: Nothing on screen\.$/m);
});
