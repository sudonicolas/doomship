import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { simulatorName, findSimulators } from '../../doctor.ts';
import { exec } from '../../exec.ts';
import type { IosConfig } from '../../config.ts';
import { repoCache } from '../../paths.ts';
import type { Layout } from './inject.ts';

/** xcodebuild can sit silent forever after the work is done, so a quiet log means it's stuck. */
export const quietLimit = 240;

export type Logged = { code: number | null; stalled: boolean; seconds: number };

/** Runs a command with its output in `log`; kills it when the log stays the same size for `quiet` seconds. */
export function runLogged(cmd: string, args: string[], log: string, quiet = quietLimit): Promise<Logged> {
  const started = Date.now();
  const fd = openSync(log, 'w');
  const child = spawn(cmd, args, { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let size = 0, still = 0, stalled = false;
  const timer = setInterval(() => {
    const now = statSync(log).size;
    if (now !== size) { size = now; still = 0; return; }
    if (++still >= quiet) {
      stalled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }
  }, 1000);
  return new Promise((done) => {
    child.on('close', (code) => {
      clearInterval(timer);
      done({ code, stalled, seconds: (Date.now() - started) / 1000 });
    });
  });
}

/** The doomship simulator's UDID. */
export function simulatorUdid(): string {
  const r = exec('xcrun', ['simctl', 'list', 'devices', '-j']);
  if (!r.ok) throw new Error(`could not list simulators: ${r.stderr.trim()}`);
  const found = findSimulators(r.stdout, simulatorName);
  if (found.length !== 1) throw new Error(`need exactly one simulator named "${simulatorName}", found ${found.length}: run doomship doctor`);
  return found[0].udid;
}

/** Build products live in the cache, per repo, so builds stay incremental and never touch Xcode's shared folder. */
export const derivedData = (repoName: string) => join(repoCache(repoName), 'DerivedData');

/** The arguments every xcodebuild call shares: the project, scheme, simulator and the cache's DerivedData. */
export function xcodebuildArgs(config: IosConfig, src: string, derivedData: string, udid: string): string[] {
  return [
    config.project.endsWith('.xcworkspace') ? '-workspace' : '-project', join(src, config.project),
    '-scheme', config.scheme,
    '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', derivedData,
  ];
}

/**
 * The first compile error in a build log, as a person would act on it: a line in demo.swift when
 * the error is in the demo (the injected file is traced back through its layout), else the file in
 * the repo; with the source line and caret xcodebuild prints under it.
 */
export function buildFailure(log: string, src: string, injectInto: string, layout: Layout): string {
  const lines = log.split('\n');
  const at = lines.findIndex((l) => /^\/.+?:\d+:\d+: error: /.test(l));
  if (at === -1) {
    const tail = lines.filter((l) => l.trim()).slice(-15).join('\n');
    return `The build failed without a compile error. The end of build.log:\n${tail}\n`;
  }
  const [, file, line, col, message] = lines[at].match(/^(\/.+?):(\d+):(\d+): error: (.*)$/)!;
  const rel = relative(src, file);
  const inInjected = rel === injectInto;
  /** A line of the injected file, as a line of the part it came from. */
  const own = (n: number) => !inInjected ? n : n >= layout.demoStart ? n - layout.demoStart + 1 : n >= layout.helperStart ? n - layout.helperStart + 1 : n;
  const n = Number(line);
  const where = !inInjected || n < layout.helperStart ? `${rel}:${n}:${col}`
    : n >= layout.demoStart ? `demo.swift:${own(n)}:${col}`
    : `the doomship helper (Doomship.swift):${own(n)}:${col}`;
  // Swift 6 prints a numbered window ("932 |   code", "    |   `- error"); older compilers the
  // source line and a caret. Either way the window is renumbered to the part's own lines.
  const after = lines.slice(at + 1);
  let window = after.slice(0, 12).filter((_, i, all) => all.slice(0, i + 1).every((l) => /^\s*\d*\s*\|/.test(l)));
  if (window.length) {
    const width = Math.max(...window.map((l) => (l.match(/^\s*(\d+)/)?.[1] ? String(own(Number(l.match(/^\s*(\d+)/)![1]))).length : 0)));
    window = window.map((l) => {
      const m = l.match(/^\s*(\d*)\s*\|(.*)$/)!;
      return `${(m[1] ? String(own(Number(m[1]))) : '').padStart(width)} |${m[2]}`;
    });
  } else {
    for (const l of after.slice(0, 2)) {
      if (/^\/.+?:\d+:\d+: /.test(l) || !l.trim()) break;
      window.push(l);
    }
  }
  return `Build failed: ${where}: error: ${message}\n${window.length ? window.join('\n') + '\n' : ''}`;
}

export const readLog = (path: string) => readFileSync(path, 'utf8');

/**
 * The bundle id of the app a UI test target drives, from an .xctestrun file (as JSON): its
 * UITargetAppPath, then that app's Info.plist (read through `plist`, which gives it as JSON).
 */
export function uiTargetBundleId(xctestrun: string, products: string, target: string, plist: (file: string) => string): string | undefined {
  type TestTarget = { BlueprintName?: string; UITargetAppPath?: string };
  // Format 2 lists targets under TestConfigurations; format 1 keys them by name at the top level.
  const run = JSON.parse(xctestrun) as { TestConfigurations?: { TestTargets?: TestTarget[] }[] } & Record<string, unknown>;
  const targets = (run.TestConfigurations ?? []).flatMap((c) => c.TestTargets ?? []);
  const app = (targets.find((t) => t.BlueprintName === target) ?? (run[target] as TestTarget | undefined))?.UITargetAppPath;
  if (!app) return undefined;
  const info = join(app.replace('__TESTROOT__', products), 'Info.plist');
  if (!existsSync(info)) return undefined;
  return (JSON.parse(plist(info)) as { CFBundleIdentifier?: string }).CFBundleIdentifier;
}

const plistJson = (file: string) => {
  const r = exec('plutil', ['-convert', 'json', '-o', '-', file]);
  if (!r.ok) throw new Error(`could not read ${file}: ${r.stderr.trim()}`);
  return r.stdout;
};

/** The bundle id of the app the config's UI tests drive, from the last build in DerivedData. */
export function appBundleId(config: IosConfig, derived: string): string | undefined {
  const products = join(derived, 'Build', 'Products');
  if (!existsSync(products)) return undefined;
  const runs = readdirSync(products).filter((f) => f.endsWith('.xctestrun'))
    .map((f) => join(products, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of runs) {
    const id = uiTargetBundleId(plistJson(file), dirname(file), config.uiTestTarget, plistJson);
    if (id) return id;
  }
  return undefined;
}
