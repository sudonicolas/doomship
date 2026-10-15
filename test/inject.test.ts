import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveChange } from '../src/change.ts';
import { loadConfig } from '../src/config.ts';
import { helperFile, inject, injected } from '../src/drivers/ios/inject.ts';
import { buildFailure } from '../src/drivers/ios/xcodebuild.ts';
import { prepare } from '../src/prepare.ts';
import { loadRun } from '../src/run.ts';

const demo = 'final class Doomship: XCTestCase {\n    func testDemo() {\n        boom()\n    }\n}\n';

test('injected: original, helper, demo; the layout says where each starts', () => {
  const { text, layout } = injected('import XCTest\nclass A {}', 'struct H {}\n', 'final class Doomship {}\n');
  assert.equal(text, 'import XCTest\nclass A {}\n\nstruct H {}\n\nfinal class Doomship {}\n');
  const lines = text.split('\n');
  assert.equal(lines[layout.helperStart - 1], 'struct H {}');
  assert.equal(lines[layout.demoStart - 1], 'final class Doomship {}');
});

test('buildFailure: an error in the demo points at demo.swift, with its source line', () => {
  const layout = { helperStart: 12, demoStart: 70 };
  const log = [
    'CompileSwift normal arm64 /src/AppUITests/AppUITests.swift',
    '/src/AppUITests/AppUITests.swift:72:9: error: cannot find \'boom\' in scope',
    '        boom()',
    '        ^~~~',
    '/src/AppUITests/AppUITests.swift:80:1: error: another',
    '** TEST BUILD FAILED **',
  ].join('\n');
  assert.equal(buildFailure(log, '/src', 'AppUITests/AppUITests.swift', layout),
    'Build failed: demo.swift:3:9: error: cannot find \'boom\' in scope\n        boom()\n        ^~~~\n');
  const swift6 = [
    '/src/AppUITests/AppUITests.swift:79:14: error: value of type \'DoomshipDemo\' has no member \'hld\'',
    '78 |         demo.caption("Today")', '79 |         demo.hld(1)', '   |              `- error: no member \'hld\'',
    '80 |         demo.end()', 'Failed frontend command:',
  ].join('\n');
  assert.equal(buildFailure(swift6, '/src', 'AppUITests/AppUITests.swift', layout), [
    'Build failed: demo.swift:10:14: error: value of type \'DoomshipDemo\' has no member \'hld\'',
    ' 9 |         demo.caption("Today")', '10 |         demo.hld(1)', '   |              `- error: no member \'hld\'',
    '11 |         demo.end()', '',
  ].join('\n'));
  assert.match(buildFailure('/src/AppUITests/AppUITests.swift:13:1: error: x', '/src', 'AppUITests/AppUITests.swift', layout),
    /^Build failed: the doomship helper \(Doomship\.swift\):2:1: error: x/);
  assert.match(buildFailure('/src/App/View.swift:5:2: error: old Swift', '/src', 'AppUITests/AppUITests.swift', layout),
    /^Build failed: App\/View\.swift:5:2: error: old Swift/);
  assert.match(buildFailure('lots\nof\n** BUILD FAILED **\n', '/src', 'x.swift', layout), /without a compile error[\s\S]*BUILD FAILED/);
});

function fixtureRun() {
  const repo = mkdtempSync(join(tmpdir(), 'doomship-inject-'));
  process.env.DOOMSHIP_CACHE = mkdtempSync(join(tmpdir(), 'doomship-cache-'));
  const write = (path: string, body: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  };
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  write('.doomship.json', JSON.stringify({ platform: 'ios', project: 'App.xcodeproj', scheme: 'App', uiTestTarget: 'AppUITests', injectInto: 'AppUITests/AppUITests.swift' }));
  write('AppUITests/AppUITests.swift', 'import XCTest\n\nfinal class AppUITests: XCTestCase {}\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Root');
  const p = prepare(repo, resolveChange(repo, 'HEAD'), loadConfig(repo));
  return loadRun(p.run);
}

test('inject: twice gives the same file, and an unchanged demo leaves it alone', () => {
  const run = fixtureRun();
  assert.throws(() => inject(run), /no demo yet/);
  writeFileSync(join(run.dir, 'demo.swift'), demo);
  const first = inject(run);
  assert.equal(first.changed, true);
  const text = readFileSync(first.path, 'utf8');
  assert.ok(text.startsWith('import XCTest\n\nfinal class AppUITests: XCTestCase {}\n\n// MARK: - doomship'));
  assert.ok(text.includes(readFileSync(helperFile, 'utf8')));
  assert.ok(text.endsWith(demo));
  const mtime = statSync(first.path).mtimeMs;
  const second = inject(run);
  assert.equal(second.changed, false);
  assert.equal(readFileSync(second.path, 'utf8'), text);
  assert.equal(statSync(second.path).mtimeMs, mtime);

  writeFileSync(join(run.dir, 'demo.swift'), demo.replace('boom', 'bang'));
  const third = readFileSync(inject(run).path, 'utf8');
  assert.equal(third.split('final class Doomship').length, 2, 'one demo, never stacked');
});

test('inject: the demo must define Doomship.testDemo', () => {
  const run = fixtureRun();
  writeFileSync(join(run.dir, 'demo.swift'), 'final class Demo: XCTestCase { func testIt() {} }\n');
  assert.throws(() => inject(run), /needs "final class Doomship: XCTestCase" with "func testDemo\(\)"/);
});
