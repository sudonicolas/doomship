import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFailure } from '../src/drivers/macos/index.ts';
import { loadConfig } from '../src/config.ts';

const demoOf = (text: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'doomship-macos-')), 'demo.swift');
  writeFileSync(file, text);
  return file;
};

test('a compile error in the demo names its line and shows the code', () => {
  const demo = demoOf('func play(_ demo: Demo) throws {\n    demo.tapp(x)\n}\n');
  const log = `/x/Doomship.swift:10:5: warning: something\n${demo}:2:10: error: value of type 'Demo' has no member 'tapp'\n`;
  assert.equal(compileFailure(log, demo),
    "The demo didn't compile: demo.swift:2:10: value of type 'Demo' has no member 'tapp'\n2 |     demo.tapp(x)\n");
});

test('an error outside the demo says where it was', () => {
  const demo = demoOf('func play(_ demo: Demo) throws {}\n');
  assert.equal(compileFailure('/r/Doomship.swift:3:1: error: oops\n', demo), "The demo didn't compile: /r/Doomship.swift:3:1: oops\n");
});

test('the Encore example config loads', () => {
  const c = loadConfig('.', 'examples/encore.doomship.json');
  assert.equal(c.platform, 'macos');
  assert.equal(c.accent, '#1F74D2');
});
