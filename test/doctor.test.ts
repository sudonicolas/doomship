import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec, ExecResult } from '../src/exec.ts';
import { ffmpegCandidates, findFfmpeg, hasSubtitlesFilter } from '../src/ffmpeg.ts';
import { checkFfmpeg, checkFonts, checkNode, checkSimulator, findSimulators, formatChecks } from '../src/doctor.ts';
import { fontsDir } from '../src/fonts.ts';

const ok = (stdout = ''): ExecResult => ({ ok: true, stdout, stderr: '' });
const fail = (stderr = ''): ExecResult => ({ ok: false, stdout: '', stderr });

/** A fake Exec keyed by the command and its first argument. */
function fakeExec(table: Record<string, ExecResult>): Exec {
  return (cmd, args) => table[`${cmd} ${args.join(' ')}`] ?? fail(`not found: ${cmd}`);
}

const withLibass = ` TS subtitles         V->V       Render text subtitles onto input video using the libass library.\n`;
const withoutLibass = ` .. null              V->V       Pass the source unchanged to the output.\n`;

test('node: 22.18 and later pass, older fails', () => {
  assert.equal(checkNode('22.18.0').ok, true);
  assert.equal(checkNode('26.10.0').ok, true);
  assert.equal(checkNode('22.11.0').ok, false);
  assert.equal(checkNode('20.19.0').ok, false);
  assert.match(checkNode('20.19.0').fix ?? '', /brew install node/);
});

test('subtitles filter is detected only as a filter name', () => {
  assert.equal(hasSubtitlesFilter(withLibass), true);
  assert.equal(hasSubtitlesFilter(withoutLibass), false);
  assert.equal(hasSubtitlesFilter(' .. foo  V->V  Burn subtitles somehow.\n'), false);
});

test('ffmpeg: env override comes first, then ffmpeg-full, then PATH', () => {
  assert.deepEqual(ffmpegCandidates({ DOOMSHIP_FFMPEG: '/x/ffmpeg' }), [
    '/x/ffmpeg',
    '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
    '/usr/local/opt/ffmpeg-full/bin/ffmpeg',
    'ffmpeg',
  ]);
  assert.equal(ffmpegCandidates({})[0], '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg');
});

test('ffmpeg: skips one without libass and finds ffmpeg-full', () => {
  const exec = fakeExec({
    'ffmpeg -hide_banner -filters': ok(withoutLibass),
    '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -filters': ok(withLibass),
  });
  assert.equal(findFfmpeg(exec, {}).path, '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg');
  assert.equal(checkFfmpeg(exec, {}).ok, true);
});

test('ffmpeg: without libass says so and how to fix it', () => {
  const check = checkFfmpeg(fakeExec({ 'ffmpeg -hide_banner -filters': ok(withoutLibass) }), {});
  assert.equal(check.ok, false);
  assert.match(check.detail, /ffmpeg has no subtitles filter/);
  assert.match(check.fix ?? '', /brew install ffmpeg-full/);
});

test('ffmpeg: missing entirely', () => {
  const check = checkFfmpeg(fakeExec({}), {});
  assert.equal(check.ok, false);
  assert.equal(check.detail, 'not found');
});

test('fonts: the vendored files pass', () => {
  assert.equal(checkFonts(fontsDir).ok, true);
});

test('fonts: a missing file and a non-font file are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doomship-fonts-'));
  writeFileSync(join(dir, 'Inter-ExtraBold.ttf'), 'not a font');
  let check = checkFonts(dir);
  assert.equal(check.ok, false);
  assert.match(check.detail, /Inter-ExtraBold\.ttf is not a TrueType font/);
  assert.match(check.detail, /OFL\.txt missing/);
  check = checkFonts(mkdtempSync(join(tmpdir(), 'doomship-fonts-')));
  assert.match(check.detail, /Inter-ExtraBold\.ttf missing/);
});

const devices = (list: Record<string, object[]>) => JSON.stringify({ devices: list });
const rt = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';

test('simulator: found by exact name, unavailable ones ignored', () => {
  const json = devices({
    [rt]: [
      { name: 'iPhone 17', udid: 'A', state: 'Shutdown', isAvailable: true },
      { name: 'doomship', udid: 'B', state: 'Shutdown', isAvailable: true },
      { name: 'doomship', udid: 'C', state: 'Shutdown', isAvailable: false },
    ],
  });
  assert.deepEqual(findSimulators(json, 'doomship').map((d) => d.udid), ['B']);
  const check = checkSimulator(fakeExec({ 'xcrun simctl list devices -j': ok(json) }));
  assert.equal(check.ok, true);
  assert.equal(check.detail, 'B (iOS-27-0)');
});

test('simulator: missing offers --fix and the create command', () => {
  const json = devices({ [rt]: [{ name: 'iPhone 17', udid: 'A', state: 'Shutdown', isAvailable: true }] });
  const check = checkSimulator(fakeExec({ 'xcrun simctl list devices -j': ok(json) }));
  assert.equal(check.ok, false);
  assert.match(check.fix ?? '', /doomship doctor --fix/);
  assert.match(check.fix ?? '', /xcrun simctl create doomship "iPhone 17"/);
});

test('simulator: two with the same name is an error', () => {
  const json = devices({
    [rt]: [
      { name: 'doomship', udid: 'B', state: 'Shutdown', isAvailable: true },
      { name: 'doomship', udid: 'D', state: 'Booted', isAvailable: true },
    ],
  });
  const check = checkSimulator(fakeExec({ 'xcrun simctl list devices -j': ok(json) }));
  assert.equal(check.ok, false);
  assert.match(check.detail, /2 simulators share the name/);
});

test('format: one line per check, fix lines indented, summary last', () => {
  const out = formatChecks([
    { name: 'Node', ok: true, detail: '26.10.0' },
    { name: 'ffmpeg with libass', ok: false, detail: 'not found', fix: 'brew install ffmpeg-full' },
  ]);
  assert.equal(
    out,
    ['✓ Node: 26.10.0', '✗ ffmpeg with libass: not found', '    fix: brew install ffmpeg-full', '', '1 of 2 checks failed.'].join('\n'),
  );
});
