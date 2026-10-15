// The web driver: the export's dependencies installed in the cache, the app started from the
// export (or a URL), and the run's demo.ts played in headless Chromium while its screen is
// captured. The repo being demoed is never touched: everything runs in the cache.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import type { WebConfig } from '../../config.ts';
import { exec } from '../../exec.ts';
import { findFfmpeg } from '../../ffmpeg.ts';
import type { Run } from '../../run.ts';
import type { Build, Driver, Recording } from '../driver.ts';
import { parseEvents } from '../ios/record.ts';
import { runLogged } from '../ios/xcodebuild.ts';
import { Demo } from './demo.ts';

export type Viewport = 'phone' | 'desktop';
/** An iPhone-sized page at 3x, with touch; or a 16:9 desktop window at 2x. */
export const viewports = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
} as const;

/** Seconds the app gets to answer at its URL after the start command. */
const startLimit = 120;
/** Seconds a demo may run. */
const demoLimit = 180;

const lockHash = (src: string) => {
  const lock = ['package-lock.json', 'npm-shrinkwrap.json'].map((f) => join(src, f)).find(existsSync);
  return lock ? createHash('sha256').update(readFileSync(lock)).digest('hex') : undefined;
};

/** The demo's own line for an error: the first stack frame in demo.ts, and its code. */
export function demoFailure(error: Error, demoFile: string, captions: string[]): string {
  const url = pathToFileURL(demoFile).href;
  const stack = error.stack ?? '';
  // Playwright gives its errors' frames as paths; Node's own errors give file URLs.
  const m = stack.split('\n').map((l) => l.match(/\((.*?):(\d+):(\d+)\)$|at (.*?):(\d+):(\d+)$/))
    .find((x) => x && [url, demoFile].includes((x[1] ?? x[4])?.split('?')[0] ?? ''));
  const line = m ? Number(m[2] ?? m[5]) : undefined;
  // Playwright's messages carry a call log; the first lines say what went wrong.
  const message = error.message.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n');
  const code = line ? readFileSync(demoFile, 'utf8').split('\n')[line - 1] : undefined;
  const where = line ? `demo.ts:${line}` : 'demo.ts';
  const reached = captions.length ? `\nThe last caption reached: "${captions.at(-1)}".` : '\nNo caption was reached.';
  return `Demo failed: ${where}: ${message}${code?.trim() ? `\n${line} | ${code}` : ''}${reached}\n`;
}

async function loadDemo(file: string): Promise<(page: unknown, demo: Demo) => Promise<void>> {
  const mod = await import(`${pathToFileURL(file).href}?at=${Date.now()}`);
  if (typeof mod.default !== 'function') throw new Error('demo.ts needs a default export: export default async function (page, demo) { … }');
  return mod.default;
}

async function prepareBuild(run: Run): Promise<Build> {
  const started = Date.now();
  const seconds = () => (Date.now() - started) / 1000;
  const fail = (failure: string): Build => {
    writeFileSync(join(run.dir, 'failure.txt'), failure);
    return { ok: false, seconds: seconds(), failure };
  };
  rmSync(join(run.dir, 'failure.txt'), { force: true });
  const config = run.config as WebConfig;
  // Dependencies, once per lockfile: the export keeps node_modules between runs (rsync leaves it,
  // as it isn't in the repo).
  if (config.start && existsSync(join(run.src, 'package.json'))) {
    const hash = lockHash(run.src) ?? 'none';
    const stamp = join(run.src, 'node_modules', '.doomship-lock');
    if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== hash) {
      const args = hash === 'none' ? ['install', '--no-audit', '--no-fund'] : ['ci', '--no-audit', '--no-fund'];
      const log = join(run.dir, 'build.log');
      const r = await new Promise<{ code: number | null }>((done) => {
        const child = spawn('npm', args, { cwd: run.src, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => { writeFileSync(log, out); done({ code }); });
      });
      if (r.code !== 0) return fail(`npm ${args[0]} failed in the export; see build.log.\n`);
      writeFileSync(stamp, hash);
    }
  }
  const demo = join(run.dir, 'demo.ts');
  if (!existsSync(demo)) return fail(`${demo}: no demo yet; write one (export default async function (page, demo) { … }) or skip\n`);
  try {
    await loadDemo(demo);
  } catch (e) {
    return fail(demoFailure(e as Error, demo, []));
  }
  return { ok: true, seconds: seconds() };
}

async function waitForUrl(url: string, server?: ChildProcess): Promise<void> {
  const deadline = Date.now() + startLimit * 1000;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error(`the start command exited (${server.exitCode}) before ${url} answered; see server.log`);
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error(`${url} didn't answer within ${startLimit} s of the start command; see server.log`);
}

async function urlAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

/** Starts the app from the export; resolves with it and its URL once it answers. */
async function startApp(run: Run): Promise<{ url: string; stop: () => void }> {
  const config = run.config as WebConfig;
  if (config.url) return { url: config.url, stop: () => {} };
  const { command, url } = config.start!;
  if (await urlAnswers(url)) throw new Error(`${url} already answers before the app was started: stop whatever is serving it, so the demo doesn't record that instead`);
  const log = join(run.dir, 'server.log');
  const out: string[] = [];
  const server = spawn(command, { cwd: run.src, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', (d) => out.push(String(d)));
  server.stderr!.on('data', (d) => out.push(String(d)));
  const stop = () => {
    writeFileSync(log, out.join(''));
    try { process.kill(-server.pid!, 'SIGTERM'); } catch { /* gone */ }
  };
  try {
    await waitForUrl(url, server);
  } catch (e) {
    stop();
    throw e;
  }
  return { url, stop };
}

type Frame = { file: string; t: number };

/**
 * Records the page as a stream of screenshots at device pixels (about 30 a second), each stamped
 * with the middle of its capture. The DevTools screencast is smoother but only sends CSS pixels,
 * a third of a phone's resolution.
 */
function capture(page: Page, dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames: Frame[] = [];
  let running = true;
  let waiters: { after: number; ok: () => void }[] = [];
  const loop = (async () => {
    while (running) {
      const a = Date.now() / 1000;
      // Bounded: a screenshot can hang (one started on about:blank as a heavy page loads), and
      // stop() waits for the loop, so an unbounded one stops even the demo's time limit.
      const shot = await page.screenshot({ type: 'jpeg', quality: 90, animations: 'allow', caret: 'initial', timeout: 3_000 }).catch(() => undefined);
      const b = Date.now() / 1000;
      if (!shot) continue; // mid-navigation, or hung
      const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
      writeFileSync(file, shot);
      frames.push({ file, t: (a + b) / 2 });
      waiters = waiters.filter((w) => (a >= w.after ? (w.ok(), false) : true));
    }
  })();
  return {
    frames,
    /** Resolves once a frame whose capture started after this call is in; fails after 30 s. */
    fresh: () => {
      const after = Date.now() / 1000;
      return new Promise<void>((ok, no) => {
        const timer = setTimeout(() => no(new Error('no frame was captured for 30 s: the page may be too busy to screenshot')), 30_000);
        waiters.push({ after, ok: () => { clearTimeout(timer); ok(); } });
      });
    },
    stop: async () => {
      running = false;
      await loop;
      return Date.now() / 1000;
    },
  };
}

/** The frames as one H.264 video, each held until the next; the last until `until`. */
function assemble(frames: Frame[], until: number, video: string, dir: string): void {
  const ffmpeg = findFfmpeg(exec, process.env).path ?? 'ffmpeg';
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? until) - f.t).toFixed(4)}`);
  list.push(`file '${frames.at(-1)!.file}'`);
  const listFile = join(dir, 'frames.txt');
  writeFileSync(listFile, list.join('\n') + '\n');
  const r = exec(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-crf', '12', '-bf', '0', '-f', 'mov', video]);
  if (!r.ok) throw new Error(`could not assemble the video: ${r.stderr.trim()}`);
}

async function record(run: Run, opts: { viewport?: Viewport } = {}): Promise<Recording> {
  const viewport = opts.viewport ?? 'phone';
  const video = join(run.dir, 'video.mov');
  const events = join(run.dir, 'events.json');
  const demoFile = join(run.dir, 'demo.ts');
  for (const f of [video, events, join(run.dir, 'failure.txt')]) rmSync(f, { force: true });
  const fail = (failure: string): Recording => {
    writeFileSync(join(run.dir, 'failure.txt'), failure);
    return { video, events, failure };
  };

  let app: Awaited<ReturnType<typeof startApp>>;
  try {
    app = await startApp(run);
  } catch (e) {
    return fail(`The app didn't start: ${(e as Error).message}\n`);
  }
  const browser = await chromium.launch();
  const v = viewports[viewport];
  const context = await browser.newContext({ ...v, baseURL: app.url, colorScheme: 'light', reducedMotion: 'no-preference' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  let cast: ReturnType<typeof capture> | undefined;
  const demo = new Demo(page, v.hasTouch, () => cast?.fresh() ?? Promise.resolve());
  let failure: string | undefined;
  let until = 0;
  try {
    const play = await loadDemo(demoFile);
    cast = capture(page, join(run.dir, 'frames'));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      play(page, demo),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error(`the demo ran for more than ${demoLimit} s`)), demoLimit * 1000); }),
    ]).finally(() => clearTimeout(timer));
    await page.waitForTimeout(300); // the last frames after end()
  } catch (e) {
    failure = demoFailure(e as Error, demoFile, demo.markers.filter((m) => m.event === 'caption').map((m) => m.text ?? ''));
  } finally {
    until = cast ? await cast.stop() : 0;
    await browser.close();
    app.stop();
  }
  if (failure) return fail(failure);
  if (!cast?.frames.length) return fail('No frames were captured.\n');

  const videoStart = cast.frames[0].t;
  assemble(cast.frames, until, video, run.dir);
  try {
    const log = demo.markers.map((m) => `DOOMSHIP ${JSON.stringify(m)}`).join('\n');
    const parsed = parseEvents(log, videoStart);
    writeFileSync(events, JSON.stringify({ ...parsed, viewport }, null, 2) + '\n');
  } catch (e) {
    return fail(`${(e as Error).message}\n`);
  }
  rmSync(join(run.dir, 'frames'), { recursive: true, force: true });
  return { video, events };
}

export const webDriver: Driver = { prepareBuild, record };
