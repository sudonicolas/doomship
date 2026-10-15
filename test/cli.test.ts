import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('--help prints usage and exits 0', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: doomship <command>/);
  assert.match(r.stdout, /doctor/);
});

test('no command prints usage and exits 64', () => {
  const r = run();
  assert.equal(r.status, 64);
  assert.match(r.stdout, /Usage:/);
});

test('an unknown command or option is a usage error', () => {
  assert.equal(run('frobnicate').status, 64);
  const r = run('doctor', '--nope');
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Unknown option '--nope'/);
});

test('doctor prints one line per check and a summary', () => {
  const r = run('doctor');
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}: ${r.stderr}`);
  for (const name of ['Node', 'xcodebuild', 'xcrun simctl', 'ffmpeg with libass', 'TikTok Sans', 'simulator "doomship"']) {
    assert.match(r.stdout, new RegExp(`^[✓✗] ${name}:`, 'm'));
  }
  assert.match(r.stdout, /(All checks passed\.|\d+ of 6 checks failed\.)$/m);
});
