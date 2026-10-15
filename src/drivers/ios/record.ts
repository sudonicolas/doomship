import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { IosConfig } from '../../config.ts';
import { exec } from '../../exec.ts';
import type { Run } from '../../run.ts';
import type { Recording } from '../driver.ts';
import { demoClass, demoMethod, injectedFor, type Layout } from './inject.ts';
import { appBundleId, derivedData, quietLimit, runLogged, simulatorUdid, xcodebuildArgs } from './xcodebuild.ts';

/** A helper call, at its time in the video. */
export type Event = {
  event: 'begin' | 'caption' | 'tap' | 'show' | 'hold' | 'end';
  /** Seconds from the video's first frame. For a tap, when the call returned. */
  t: number;
  /** A tap: when the call started; the touch shows about 0.15 s later. */
  t0?: number;
  text?: string;
  /** Points: a tap's centre, a spotlight's top-left; begin's window size. */
  x?: number; y?: number; w?: number; h?: number;
  seconds?: number;
};
export type Events = { videoStart: number; events: Event[] };

const kinds = new Set(['begin', 'caption', 'tap', 'show', 'hold', 'end']);

/**
 * The helper's markers in a test log, as seconds into the video. Throws, with what to fix, when
 * the demo didn't call begin and end, in that order.
 */
export function parseEvents(log: string, videoStart: number): Events {
  const events: Event[] = [];
  for (const m of log.matchAll(/DOOMSHIP (\{.*\})/g)) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (!kinds.has(raw.event as string) || typeof raw.t !== 'number') continue;
    const e = { ...raw, t: round(raw.t - videoStart) } as Event;
    if (typeof raw.t0 === 'number') e.t0 = round(raw.t0 - videoStart);
    events.push(e);
  }
  events.sort((a, b) => a.t - b.t);
  const begin = events.findIndex((e) => e.event === 'begin');
  const end = events.findIndex((e) => e.event === 'end');
  if (begin === -1) throw new Error('The demo never called demo.begin(), so the GIF has no start. Call it once the first screen is up.');
  if (end === -1) throw new Error('The demo never called demo.end(), so the GIF has no end. Call it after holding on the result.');
  if (end < begin) throw new Error('The demo called demo.end() before demo.begin().');
  return { videoStart, events };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The first test failure, as a person would act on it: the message and its line, traced back to
 * demo.swift through the injected file's layout, and the last caption the demo reached.
 */
export function testFailure(log: string, src: string, injectInto: string, layout: Layout, injectedText = ''): string {
  const m = log.match(/^(\/.+?):(\d+): error: (?:-\[[^\]]+\] : )?(.*)$/m);
  const captions = [...log.matchAll(/DOOMSHIP (\{.*"event":"caption".*\})/g)].map((c) => JSON.parse(c[1]).text as string);
  const reached = captions.length ? `\nThe last caption reached: "${captions.at(-1)}".` : '\nNo caption was reached.';
  if (!m) {
    const tail = log.split('\n').filter((l) => l.trim()).slice(-15).join('\n');
    return `The demo failed without an assertion message.${reached}\nThe end of test.log:\n${tail}\n`;
  }
  const [, file, line, message] = m;
  const rel = relative(src, file);
  const n = Number(line);
  let where = `${rel}:${n}`;
  let source = '';
  if (rel === injectInto && n >= layout.demoStart) {
    where = `demo.swift:${n - layout.demoStart + 1}`;
    const code = injectedText.split('\n')[n - 1];
    if (code?.trim()) source = `\n${n - layout.demoStart + 1} | ${code}`;
  } else if (rel === injectInto && n >= layout.helperStart) where = `the doomship helper (Doomship.swift):${n - layout.helperStart + 1}`;
  const hint = /waitForExistence/.test(source)
    ? '\nThe element it waited for never appeared: check the identifier or label against context.md, and that the step before it reached this screen.'
    : '';
  return `Test failed: ${where}: ${message.trim()}${source}${reached}${hint}\n`;
}

/** Boots the simulator and sets it up as every recording expects: light, 9:41, full battery. */
function readySimulator(udid: string, reboot: boolean): void {
  if (reboot) exec('xcrun', ['simctl', 'shutdown', udid]);
  exec('xcrun', ['simctl', 'boot', udid]); // fails harmlessly when already booted
  const booted = exec('xcrun', ['simctl', 'bootstatus', udid, '-b']);
  if (!booted.ok) throw new Error(`the doomship simulator didn't boot: ${booted.stderr.trim()}`);
  exec('xcrun', ['simctl', 'ui', udid, 'appearance', 'light']);
  exec('xcrun', ['simctl', 'status_bar', udid, 'override', '--time', '9:41', '--batteryLevel', '100',
    '--batteryState', 'charged', '--cellularBars', '4', '--wifiBars', '3']);
}

/** Starts recording the screen; resolves with the wall-clock time of the video's first frame. */
function startRecording(udid: string, video: string) {
  const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', video], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const started = new Promise<number>((ok, fail) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`the recording didn't start in 30 s: ${err.trim()}`)); }, 30_000);
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      // The video's clock starts when simctl says so (measured: within one frame).
      if (err.includes('Recording started')) { clearTimeout(timer); ok(Date.now() / 1000); }
    });
    child.on('close', (code) => { clearTimeout(timer); fail(new Error(`the recording stopped (exit ${code}): ${err.trim()}`)); });
  });
  const stop = () => new Promise<void>((done) => {
    if (child.exitCode !== null) return done();
    child.on('close', () => done());
    child.kill('SIGINT'); // lets simctl finish the file
    setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
  });
  return { started, stop };
}

/** One recording: the screen, while xcodebuild runs only the demo. */
async function recordOnce(run: Run, udid: string, reboot: boolean): Promise<Recording & { seconds: number }> {
  const config = run.config as IosConfig;
  const video = join(run.dir, 'video.mov');
  const events = join(run.dir, 'events.json');
  const log = join(run.dir, 'test.log');
  for (const f of [video, events, log, join(run.dir, 'failure.txt')]) rmSync(f, { force: true });

  readySimulator(udid, reboot);
  // A fresh install every time (the test run installs it again), so nothing a demo or an earlier
  // recording saved, such as UserDefaults, carries over into this one.
  const bundleId = appBundleId(config, derivedData(run.repoName));
  if (bundleId) exec('xcrun', ['simctl', 'uninstall', udid, bundleId]);
  const rec = startRecording(udid, video);
  const videoStart = await rec.started;
  const args = ['test-without-building', ...xcodebuildArgs(config, run.src, derivedData(run.repoName), udid),
    `-only-testing:${config.uiTestTarget}/${demoClass}/${demoMethod}`, '-collect-test-diagnostics', 'never'];
  const r = await runLogged('xcodebuild', args, log);
  await rec.stop();
  if (r.stalled) return { video, events, stalled: true, seconds: r.seconds, failure: `The demo stalled: xcodebuild printed nothing for ${quietLimit} s and was stopped.\n` };

  const text = readFileSync(log, 'utf8');
  let failure: string | undefined;
  if (r.code !== 0) {
    const planned = injectedFor(run);
    failure = testFailure(text, run.src, config.injectInto, planned.layout, planned.text);
  } else {
    try {
      writeFileSync(events, JSON.stringify(parseEvents(text, videoStart), null, 2) + '\n');
    } catch (e) {
      failure = `${(e as Error).message}\n`;
    }
  }
  return { video, events, failure, seconds: r.seconds };
}

/**
 * Records the run's demo (built by prepareBuild) on the doomship simulator. A stall reboots the
 * simulator and tries once more. Writes video.mov, events.json and test.log, or failure.txt.
 */
export async function recordIos(run: Run): Promise<Recording> {
  const udid = simulatorUdid();
  let last: Recording & { seconds: number } | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await recordOnce(run, udid, attempt === 2);
    if (!last.stalled) break;
  }
  const result = last!;
  if (result.stalled) result.failure = `The demo stalled twice, the second time after a simulator reboot: xcodebuild printed nothing for ${quietLimit} s. See test.log.\n`;
  if (result.failure) writeFileSync(join(run.dir, 'failure.txt'), result.failure);
  return result;
}
