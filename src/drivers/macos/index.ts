// The macOS driver, for a SwiftUI or AppKit app built with Swift Package Manager: the export is
// built with `swift build`, the helper (resources/macos/Doomship.swift) and the run's demo.swift
// are compiled into a dylib, and the app is launched with that dylib inserted. The helper plays the
// demo inside the app and captures the app's own windows, so no Screen Recording permission is
// needed; driving it through the accessibility API needs the Accessibility permission that
// XCUITest needs too. The app runs with its home folder in the cache, so it reads and writes none
// of your data, and with a private clipboard. The repo is never touched.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MacosConfig } from '../../config.ts';
import { exec } from '../../exec.ts';
import { repoCache } from '../../paths.ts';
import type { Run } from '../../run.ts';
import type { Build, Driver, Recording } from '../driver.ts';
import { parseEvents } from '../ios/record.ts';
import { runLogged } from '../ios/xcodebuild.ts';
import { assemble, type Frame } from '../web/index.ts';

export const helperSwift = join(dirname(fileURLToPath(import.meta.url)), '../../../resources/macos/Doomship.swift');
/** Seconds of quiet before a build or a recording is killed; the helper ends a demo at 170 s. */
const quiet = { build: 240, record: 200 };

const config = (run: Run) => run.config as MacosConfig;
const packageDir = (run: Run) => join(run.src, config(run).package);
const dylib = (run: Run) => join(run.dir, 'build', 'libdoomship.dylib');
/** The app's home folder while it's recorded: fresh each time, so no state leaks between recordings. */
export const homeDir = (repoName: string) => join(repoCache(repoName), 'home');

/**
 * The first compiler error in demo.swift, as a person would act on it: its line, the message and
 * the code; or the first error anywhere, with where it was.
 */
export function compileFailure(log: string, demoFile: string): string {
  const errors = [...log.matchAll(/^(.+?):(\d+):(\d+): error: (.*)$/gm)];
  const inDemo = errors.find((m) => m[1] === demoFile);
  const m = inDemo ?? errors[0];
  if (!m) return `The demo didn't compile, with no error line; the end of build.log:\n${log.split('\n').slice(-15).join('\n')}\n`;
  const [, file, line, col, message] = m;
  if (file !== demoFile) return `The demo didn't compile: ${file}:${line}:${col}: ${message}\n`;
  const code = readFileSync(demoFile, 'utf8').split('\n')[Number(line) - 1];
  return `The demo didn't compile: demo.swift:${line}:${col}: ${message}${code?.trim() ? `\n${line} | ${code}` : ''}\n`;
}

async function prepareBuild(run: Run): Promise<Build> {
  const started = Date.now();
  const seconds = () => (Date.now() - started) / 1000;
  const fail = (failure: string): Build => {
    writeFileSync(join(run.dir, 'failure.txt'), failure);
    return { ok: false, seconds: seconds(), failure };
  };
  rmSync(join(run.dir, 'failure.txt'), { force: true });
  const demo = join(run.dir, 'demo.swift');
  if (!existsSync(demo)) return fail(`${demo}: no demo yet; write one (func play(_ demo: Demo) throws { … }) or skip\n`);

  const log = join(run.dir, 'build.log');
  const app = await runLogged('swift', ['build', '--package-path', packageDir(run), '--product', config(run).product], log, quiet.build);
  if (app.stalled) return fail('swift build went quiet for 4 minutes and was stopped; see build.log.\n');
  if (app.code !== 0) {
    const first = readFileSync(log, 'utf8').match(/^.+?:\d+:\d+: error: .*$/m)?.[0];
    return fail(`The app didn't build at this change${first ? `: ${first}` : ''}; see build.log.\n`);
  }

  mkdirSync(dirname(dylib(run)), { recursive: true });
  const demoLog = join(run.dir, 'build-demo.log');
  const helper = await runLogged('xcrun', ['swiftc', '-emit-library', '-swift-version', '5', '-module-name', 'DoomshipDemo',
    '-suppress-warnings', '-Xlinker', '-init', '-Xlinker', '_doomship_init',
    '-o', dylib(run), helperSwift, demo], demoLog, quiet.build);
  if (helper.code !== 0) return fail(compileFailure(readFileSync(demoLog, 'utf8'), demo));
  return { ok: true, seconds: seconds() };
}

/** The built app: the product in swift build's bin folder. */
function executable(run: Run): string {
  const r = exec('swift', ['build', '--package-path', packageDir(run), '--show-bin-path']);
  if (!r.ok) throw new Error(`swift build --show-bin-path failed: ${r.stderr.trim()}`);
  return join(r.stdout.trim(), config(run).product);
}

async function record(run: Run): Promise<Recording> {
  const video = join(run.dir, 'video.mov');
  const events = join(run.dir, 'events.json');
  const out = join(run.dir, 'capture');
  for (const f of [video, events, join(run.dir, 'failure.txt'), out]) rmSync(f, { recursive: true, force: true });
  const fail = (failure: string, stalled = false): Recording => {
    writeFileSync(join(run.dir, 'failure.txt'), failure);
    return { video, events, failure, stalled };
  };

  const home = homeDir(run.repoName);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const app = executable(run);
  if (!existsSync(app)) return fail(`${app}: the app isn't built; run doomship build first\n`);
  const env = {
    ...process.env, HOME: home, CFFIXED_USER_HOME: home,
    DYLD_INSERT_LIBRARIES: dylib(run), DOOMSHIP_OUT: out,
  };
  const r = await runLogged(app, config(run).launchArguments, join(run.dir, 'app.log'), quiet.record, { cwd: home, env });
  if (r.stalled) return fail('The app went quiet for 200 s and was stopped; see app.log.\n', true);
  if (existsSync(join(out, 'failure.txt'))) return fail(readFileSync(join(out, 'failure.txt'), 'utf8'));
  if (r.code !== 0 || !existsSync(join(out, 'frames.json'))) {
    const tail = readFileSync(join(run.dir, 'app.log'), 'utf8').split('\n').filter((l) => l.trim()).slice(-10).join('\n');
    return fail(`The app exited (${r.code}) before the demo finished. The end of app.log:\n${tail}\n`);
  }

  const frames = JSON.parse(readFileSync(join(out, 'frames.json'), 'utf8')) as Frame[];
  if (!frames.length) return fail('No frames were captured.\n');
  try {
    assemble(frames, frames.at(-1)!.t + 0.05, video, run.dir);
    const parsed = parseEvents(readFileSync(join(out, 'events.log'), 'utf8'), frames[0].t);
    writeFileSync(events, JSON.stringify(parsed, null, 2) + '\n');
  } catch (e) {
    return fail(`${(e as Error).message}\n`);
  }
  rmSync(join(out, 'frames'), { recursive: true, force: true });
  return { video, events };
}

export const macosDriver: Driver = { prepareBuild, record };
