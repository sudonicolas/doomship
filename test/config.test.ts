import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, colorsetHex, defaultAccent, loadConfig, validateConfig } from '../src/config.ts';

const ios = {
  platform: 'ios', project: 'App.xcodeproj', scheme: 'App', uiTestTarget: 'AppUITests',
  injectInto: 'AppUITests/AppUITests.swift',
};
const errorsOf = (raw: unknown) => {
  const r = validateConfig(raw, 'x.json');
  return 'errors' in r ? r.errors : [];
};

test('a minimal ios config is valid and gets defaults', () => {
  const r = validateConfig(ios, 'x.json');
  assert.ok('config' in r);
  assert.equal(r.config.platform, 'ios');
  if (r.config.platform !== 'ios') return;
  assert.equal(r.config.simulator, 'iPhone 17');
  assert.deepEqual(r.config.launchArguments, []);
  assert.deepEqual(r.config.areas, {});
  assert.deepEqual(r.config.notes, []);
});

test('a minimal macos config is valid and gets defaults', () => {
  const r = validateConfig({ platform: 'macos', product: 'Encore' }, 'x.json');
  assert.ok('config' in r);
  if (r.config.platform !== 'macos') return assert.fail('not macos');
  assert.equal(r.config.package, '.');
  assert.equal(r.config.product, 'Encore');
  assert.deepEqual(r.config.launchArguments, []);
});

test('web configs need start or url, not both', () => {
  assert.deepEqual(errorsOf({ platform: 'web', url: 'https://preview.example.com' }), []);
  assert.deepEqual(errorsOf({ platform: 'web', start: { command: 'npm run dev', url: 'http://localhost:3000' } }), []);
  assert.match(errorsOf({ platform: 'web' })[0], /^start or url: one is required/);
  assert.match(errorsOf({ platform: 'web', url: 'u', start: { command: 'c', url: 'u' } })[0], /give one, not both/);
  assert.match(errorsOf({ platform: 'web', start: { command: 'npm run dev' } })[0], /^start: must be how to start the app/);
});

test('each bad field is named and explained', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{}, /^platform: required, "ios", "web" or "macos"/],
    [{ platform: 'android' }, /^platform: must be "ios", "web" or "macos", not "android"/],
    [{ ...ios, scheme: undefined }, /^scheme: required for ios, the Xcode scheme/],
    [{ ...ios, scheme: '' }, /^scheme: must be the Xcode scheme/],
    [{ ...ios, project: 'App' }, /^project: must end in \.xcodeproj or \.xcworkspace/],
    [{ ...ios, injectInto: 'AppUITests/' }, /^injectInto: must be a \.swift file/],
    [{ ...ios, accent: 'purple' }, /^accent: must be a hex colour like "#5856D6", not "purple"/],
    [{ ...ios, accent: '#58D' }, /^accent: must be a hex colour/],
    [{ ...ios, launchArguments: '-uiTesting' }, /^launchArguments: must be arguments the app is launched with/],
    [{ ...ios, notes: [1] }, /^notes: must be facts about the app/],
    [{ ...ios, areas: ['ui'] }, /^areas: must be area name to a list of globs/],
    [{ ...ios, areas: { ui: [] } }, /^areas\.ui: must be a non-empty list of globs/],
    [{ ...ios, colour: '#000000' }, /^colour: not a field doomship knows; the fields for ios are platform, project/],
    [{ ...ios, url: 'https://x' }, /^url: only for web apps, and this one is ios/],
    [{ platform: 'web', url: 'u', scheme: 'App' }, /^scheme: only for ios apps/],
    [{ platform: 'macos' }, /^product: required for macos, the Swift package's executable product/],
    [{ platform: 'macos', product: 'App', project: 'App.xcodeproj' }, /^project: only for ios apps, and this one is macos/],
    [{ platform: 'web', url: 'u', product: 'App' }, /^product: only for macos apps/],
  ];
  for (const [raw, expected] of cases) {
    const errors = errorsOf(raw);
    assert.equal(errors.length, 1, `${JSON.stringify(raw)} gave ${JSON.stringify(errors)}`);
    assert.match(errors[0], expected);
  }
});

test('all problems are reported at once', () => {
  assert.equal(errorsOf({ platform: 'ios', accent: 'x', notes: 'y' }).length, 6);
});

test('asset catalog colours: floats, hex and 8-bit, light appearance first', () => {
  const set = (comps: Record<string, string>, dark = false) => JSON.stringify({
    colors: [
      ...(dark ? [{ appearances: [{ appearance: 'luminosity', value: 'dark' }], color: { components: { red: '1.000', green: '1.000', blue: '1.000' } } }] : []),
      { color: { 'color-space': 'srgb', components: { alpha: '1.000', ...comps } }, idiom: 'universal' },
    ],
  });
  assert.equal(colorsetHex(set({ red: '0.345', green: '0.337', blue: '0.839' }, true)), '#5856D6');
  assert.equal(colorsetHex(set({ red: '0x58', green: '0x56', blue: '0xD6' })), '#5856D6');
  assert.equal(colorsetHex(set({ red: '88', green: '86', blue: '214' })), '#5856D6');
  assert.equal(colorsetHex('{"colors":[{"idiom":"universal"}]}'), undefined);
  assert.equal(colorsetHex('not json'), undefined);
});

function repoWith(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), 'doomship-config-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  execFileSync('git', ['-C', repo, 'add', '-A']);
  return repo;
}
const colorset = (r: string) => JSON.stringify({ colors: [{ color: { components: { red: r, green: '0', blue: '0' } } }] });

test('the accent: the config, else the app\'s AccentColor asset, else the default', () => {
  const app = 'App/Assets.xcassets/AccentColor.colorset/Contents.json';
  const widget = 'AWidgets/Assets.xcassets/AccentColor.colorset/Contents.json';
  const repo = repoWith({ '.doomship.json': JSON.stringify(ios), [app]: colorset('1.0'), [widget]: colorset('0.5') });
  const c = loadConfig(repo);
  assert.equal(c.accent, '#FF0000');
  assert.equal(c.accentFrom, app);

  const pinned = repoWith({ '.doomship.json': JSON.stringify({ ...ios, accent: '#5856d6' }), [app]: colorset('1.0') });
  assert.equal(loadConfig(pinned).accent, '#5856D6');
  assert.equal(loadConfig(pinned).accentFrom, 'config');

  const bare = repoWith({ '.doomship.json': JSON.stringify(ios) });
  assert.equal(loadConfig(bare).accent, defaultAccent);
});

test('--config wins over the repo, and file problems are explained', () => {
  const repo = repoWith({ 'README.md': 'x' });
  assert.throws(() => loadConfig(repo), (e: Error) => e instanceof ConfigError && /no config; add one to the repo or pass --config/.test(e.message));
  const dir = mkdtempSync(join(tmpdir(), 'doomship-config-file-'));
  const file = join(dir, 'app.json');
  writeFileSync(file, JSON.stringify(ios));
  assert.equal(loadConfig(repo, file).file, file);
  writeFileSync(file, '{ "platform": ');
  assert.throws(() => loadConfig(repo, file), /not valid JSON/);
  writeFileSync(file, JSON.stringify({ ...ios, accent: 'x' }));
  assert.throws(() => loadConfig(repo, file), /app\.json:\n {2}accent: must be a hex colour/);
  assert.throws(() => loadConfig(repo, join(dir, 'missing.json')), /no such file/);
});

test('every example is a valid config', () => {
  const dir = fileURLToPath(new URL('../examples/', import.meta.url));
  for (const name of (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith('.json'))) {
    const r = validateConfig(JSON.parse(readFileSync(join(dir, name), 'utf8')), name);
    assert.ok('config' in r, `${name}: ${JSON.stringify(r)}`);
  }
});
