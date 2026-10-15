import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveChange } from '../src/change.ts';
import { loadConfig } from '../src/config.ts';
import { renderContext } from '../src/context.ts';
import { parsePatch } from '../src/diff.ts';
import { areaOf, globToRegExp } from '../src/glob.ts';
import { prepare } from '../src/prepare.ts';
import { elideTests, swiftStrings } from '../src/swift.ts';

test('globs: ** crosses folders, * does not', () => {
  assert.ok(globToRegExp('App/**').test('App/Settings/SettingsView.swift'));
  assert.ok(globToRegExp('*Tests/**').test('AppUITests/AppUITests.swift'));
  assert.ok(!globToRegExp('*Tests/**').test('KinKit/Tests/A.swift'));
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('docs/ROADMAP.md'));
  assert.equal(areaOf('KinKit/Tests/A.swift', { test: ['KinKit/Tests/**'], engine: ['KinKit/**'] }), 'test');
  assert.equal(areaOf('x.txt', { ui: ['App/**'] }), null);
});

test('parsePatch: status, counts, renames, binaries and added line numbers', () => {
  const patch = [
    'diff --git a/A B.swift b/A B.swift', 'index 1..2 100644', '--- a/A B.swift', '+++ b/A B.swift',
    '@@ -1,3 +1,4 @@', ' one', '-two', '+two!', '+three', ' four',
    'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hi',
    'diff --git a/old.swift b/moved.swift', 'similarity index 90%', 'rename from old.swift', 'rename to moved.swift',
    'diff --git a/gone.png b/gone.png', 'deleted file mode 100644', 'Binary files a/gone.png and /dev/null differ', '',
  ].join('\n');
  const files = parsePatch(patch);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.added, f.removed, f.binary]), [
    ['A B.swift', 'modified', 2, 1, false],
    ['new.txt', 'added', 1, 0, false],
    ['moved.swift', 'renamed', 0, 0, false],
    ['gone.png', 'deleted', 0, 0, true],
  ]);
  assert.deepEqual(files[0].addedLines, [2, 3]);
  assert.equal(files[2].from, 'old.swift');
});

test('swiftStrings: identifiers and visible strings, once each, comments skipped', () => {
  const src = [
    'Text("Training days")',
    '    .accessibilityIdentifier("sessionLength")',
    '// Text("not this")',
    'Button("Save") { save() }; Text("Training days")',
    'Toggle("Hourly \\"reset\\"", isOn: $on)',
    'Stepper("Age \\(age)", value: $age)',
    'myText("nope")',
    'Text(today.map { "Today: \\($0.summary)" } ?? "Ten seconds: mood and conditions")',
    'let key = "sessionLength"; print("not shown on screen")',
  ].join('\n');
  assert.deepEqual(swiftStrings(src).map((f) => [f.kind, f.value, f.line]), [
    ['Text', 'Training days', 1],
    ['accessibilityIdentifier', 'sessionLength', 2],
    ['Button', 'Save', 4],
    ['Toggle', 'Hourly \\"reset\\"', 5],
    ['Stepper', 'Age \\(age)', 6],
    ['String', 'Today: \\($0.summary)', 8],
    ['String', 'Ten seconds: mood and conditions', 8],
  ]);
});

test('elideTests: untouched test bodies become one line; helpers and touched tests stay', () => {
  const src = [
    'final class T: XCTestCase {',             // 1
    '    @MainActor',                           // 2
    '    func testA() throws {',                // 3
    '        let s = "{ not a brace"',          // 4
    '        if x { y() }',                     // 5
    '    }',                                    // 6
    '    func testB() {',                       // 7
    '        tap()',                            // 8
    '    }',                                    // 9
    '    private func helper() {',              // 10
    '        z()',                              // 11
    '    }',                                    // 12
    '}',
  ].join('\n');
  const { text, elided } = elideTests(src, new Set([8]));
  assert.equal(elided, 1);
  assert.equal(text, [
    'final class T: XCTestCase {', '    @MainActor', '    func testA() throws {', '        // 2 lines not shown', '    }',
    '    func testB() {', '        tap()', '    }', '    private func helper() {', '        z()', '    }', '}',
  ].join('\n'));
});

test('renderContext cuts the largest files first, says so, and stays under the cap', () => {
  const parts = [
    { text: '# Title' },
    { file: 'Big.swift', label: 'Big.swift', lang: 'swift', body: 'b'.repeat(3000) },
    { file: 'Mid.swift', label: 'Mid.swift', lang: 'swift', body: 'm'.repeat(1500) },
    { file: 'Small.swift', label: 'Small.swift', lang: 'swift', body: 's'.repeat(200) },
  ];
  const { text, cut } = renderContext(parts, '/src', 2048);
  assert.deepEqual(cut, ['Big.swift']);
  assert.ok(Buffer.byteLength(text) <= 2048);
  assert.match(text, /^# Title\n\n\*\*Cut to fit:\*\* Big\.swift\./);
  assert.match(text, /### Big\.swift\n\nCut to keep this file under 2 KB \(2\.9 KB\)\. Read \/src\/Big\.swift\./);
  assert.ok(text.includes('m'.repeat(1500)));
  const all = renderContext(parts, '/src', 200);
  assert.ok(Buffer.byteLength(all.text) <= 200);
  assert.deepEqual(all.cut, ['Big.swift', 'Mid.swift', 'Small.swift', 'the end']);
});

/** An iOS-shaped repo with a config, a UI commit, a non-UI commit and a dirty working tree. */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'doomship-prepare-'));
  process.env.DOOMSHIP_CACHE = mkdtempSync(join(tmpdir(), 'doomship-cache-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  const write = (path: string, body: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  };
  const commit = (subject: string) => {
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', subject);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'main');
  write('.doomship.json', JSON.stringify({
    platform: 'ios', project: 'App.xcodeproj', scheme: 'App', uiTestTarget: 'AppUITests',
    injectInto: 'AppUITests/AppUITests.swift', accent: '#5856D6',
    areas: { ui: ['App/**'], engine: ['Core/**'] }, notes: ['Launch with -uiTesting.'],
  }));
  write('App/Settings.swift', 'Form {\n    Text("Units")\n}\n');
  write('AppUITests/AppUITests.swift', 'final class AppUITests: XCTestCase {\n    func testSettings() {\n        app.launch()\n    }\n}\n');
  write('Core/Model.swift', 'struct Model {}\n');
  commit('Root');
  write('App/Settings.swift', 'Form {\n    Text("Units")\n    Toggle("Training days", isOn: $on)\n        .accessibilityIdentifier("trainingDays")\n}\n');
  const ui = commit('Add training days\n\nA toggle in Settings.');
  write('Core/Model.swift', 'struct Model { var days = 3 }\n');
  const engine = commit('Days in the model');
  write('App/New.swift', 'Button("Invite a coach") {}\n');
  write('App/Settings.swift', 'Form {\n    Text("Units!")\n}\n');
  unlinkSync(join(repo, 'Core/Model.swift'));
  return { repo, g, ui, engine };
}

test('prepare: a UI commit gives the export, the diff, changes.json and context.md', () => {
  const { repo, ui } = fixture();
  const p = prepare(repo, resolveChange(repo, ui), loadConfig(repo));
  assert.equal(readFileSync(join(p.src, 'App/Settings.swift'), 'utf8').includes('trainingDays'), true);
  assert.equal(readFileSync(join(p.src, 'Core/Model.swift'), 'utf8'), 'struct Model {}\n');
  assert.deepEqual(readdirSync(p.run).sort(), ['changes.json', 'context.md', 'diff.patch', 'run.json']);
  const changes = JSON.parse(readFileSync(join(p.run, 'changes.json'), 'utf8'));
  assert.deepEqual(changes.files, [{ path: 'App/Settings.swift', status: 'modified', area: 'ui', binary: false, added: 2, removed: 0 }]);
  const context = readFileSync(join(p.run, 'context.md'), 'utf8');
  assert.match(context, /^# Add training days\n/);
  assert.match(context, /A toggle in Settings\./);
  assert.match(context, /- Toggle: "Training days" \(new\) \(line 3\)/);
  assert.match(context, /- accessibilityIdentifier: "trainingDays" \(new\) \(line 4\)/);
  assert.match(context, /- Text: "Units" \(line 2\)\n/);
  assert.match(context, /- Launch with -uiTesting\./);
  assert.match(context, /## The UI tests the demo goes into[\s\S]*\/\/ 1 lines not shown/);
});

test('prepare: a commit with no UI files says so', () => {
  const { repo, engine } = fixture();
  const p = prepare(repo, resolveChange(repo, engine), loadConfig(repo));
  assert.deepEqual(p.uiFiles, []);
  assert.match(readFileSync(join(p.run, 'context.md'), 'utf8'), /No changed file is in the ui area/);
});

test('prepare: the working tree includes untracked files and deletions, and leaves the repo alone', () => {
  const { repo, g } = fixture();
  const before = g('status', '--porcelain=v2');
  const indexTime = statSync(join(repo, '.git/index')).mtimeMs;
  const p = prepare(repo, resolveChange(repo, undefined), loadConfig(repo));
  assert.equal(readFileSync(join(p.src, 'App/New.swift'), 'utf8'), 'Button("Invite a coach") {}\n');
  assert.throws(() => statSync(join(p.src, 'Core/Model.swift')));
  const files = JSON.parse(readFileSync(join(p.run, 'changes.json'), 'utf8')).files;
  assert.deepEqual(files.map((f: { path: string; status: string }) => [f.path, f.status]), [
    ['App/Settings.swift', 'modified'], ['Core/Model.swift', 'deleted'], ['App/New.swift', 'added'],
  ]);
  assert.match(readFileSync(join(p.run, 'context.md'), 'utf8'), /- Button: "Invite a coach" \(new\)/);
  assert.equal(statSync(join(repo, '.git/index')).mtimeMs, indexTime);
  assert.equal(g('status', '--porcelain=v2'), before);
});

test('prepare: running twice gives identical files; unchanged exports keep their dates', () => {
  const { repo, ui, engine } = fixture();
  const config = loadConfig(repo);
  const read = (run: string) => readdirSync(run).map((f) => readFileSync(join(run, f), 'utf8'));
  const first = prepare(repo, resolveChange(repo, ui), config);
  const once = read(first.run);
  const mtime = statSync(join(first.src, 'AppUITests/AppUITests.swift')).mtimeMs;
  prepare(repo, resolveChange(repo, engine), config);
  const again = prepare(repo, resolveChange(repo, ui), config);
  assert.deepEqual(read(again.run), once);
  assert.equal(statSync(join(again.src, 'AppUITests/AppUITests.swift')).mtimeMs, mtime);
});
