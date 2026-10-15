import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec } from './exec.ts';
import { findFfmpeg } from './ffmpeg.ts';
import { fontFiles, fontLicense } from './fonts.ts';

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

export const simulatorName = 'doomship';
export const simulatorDeviceType = 'iPhone 17';
export const createSimulatorArgs = ['simctl', 'create', simulatorName, simulatorDeviceType];

/** 22.18 is the first Node 22 that runs TypeScript without a flag. */
export function checkNode(version: string): Check {
  const [major, minor] = version.split('.').map(Number);
  const ok = major > 22 || (major === 22 && minor >= 18);
  return {
    name: 'Node',
    ok,
    detail: ok ? version : `${version}, needs 22.18 or later`,
    fix: ok ? undefined : 'brew install node',
  };
}

export function checkXcodebuild(exec: Exec): Check {
  const r = exec('xcodebuild', ['-version']);
  const first = r.stdout.split('\n')[0]?.trim();
  return r.ok
    ? { name: 'xcodebuild', ok: true, detail: first || 'found' }
    : {
        name: 'xcodebuild',
        ok: false,
        detail: firstLine(r.stderr) || 'not found',
        fix: 'Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app',
      };
}

export function checkSimctl(exec: Exec): Check {
  const r = exec('xcrun', ['simctl', 'help']);
  return r.ok
    ? { name: 'xcrun simctl', ok: true, detail: 'found' }
    : {
        name: 'xcrun simctl',
        ok: false,
        detail: firstLine(r.stderr) || 'not found',
        fix: 'Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app',
      };
}

export function checkFfmpeg(exec: Exec, env: NodeJS.ProcessEnv): Check {
  const found = findFfmpeg(exec, env);
  if (found.path) return { name: 'ffmpeg with libass', ok: true, detail: found.path };
  const detail = found.withoutLibass.length
    ? `${found.withoutLibass.join(', ')} has no subtitles filter (built without libass)`
    : 'not found';
  return {
    name: 'ffmpeg with libass',
    ok: false,
    detail,
    fix: 'brew install ffmpeg-full (keg-only; doomship finds it), or set DOOMSHIP_FFMPEG',
  };
}

export function checkFonts(dir: string): Check {
  const problems: string[] = [];
  for (const file of fontFiles) {
    const path = join(dir, file);
    if (!existsSync(path)) problems.push(`${file} missing`);
    else if (readFileSync(path).readUInt32BE(0) !== 0x00010000) problems.push(`${file} is not a TrueType font`);
  }
  if (!existsSync(join(dir, fontLicense))) problems.push(`${fontLicense} missing`);
  return problems.length
    ? {
        name: 'TikTok Sans',
        ok: false,
        detail: problems.join('; '),
        fix: 'Restore resources/fonts/ from git: git checkout -- resources/fonts',
      }
    : { name: 'TikTok Sans', ok: true, detail: fontFiles.join(', ') };
}

type SimDevice = { name: string; udid: string; state: string; isAvailable?: boolean };

export function findSimulators(listJson: string, name: string): (SimDevice & { runtime: string })[] {
  const parsed = JSON.parse(listJson) as { devices: Record<string, SimDevice[]> };
  return Object.entries(parsed.devices).flatMap(([runtime, devices]) =>
    devices.filter((d) => d.name === name && d.isAvailable !== false).map((d) => ({ ...d, runtime })),
  );
}

export function checkSimulator(exec: Exec): Check {
  const name = `simulator "${simulatorName}"`;
  const r = exec('xcrun', ['simctl', 'list', 'devices', '-j']);
  if (!r.ok) return { name, ok: false, detail: 'could not list simulators', fix: 'Fix xcrun simctl first' };
  const found = findSimulators(r.stdout, simulatorName);
  if (found.length === 0) {
    return {
      name,
      ok: false,
      detail: 'not found',
      fix: `doomship doctor --fix, or: xcrun ${createSimulatorArgs.slice(0, 3).join(' ')} "${simulatorDeviceType}"`,
    };
  }
  if (found.length > 1) {
    return {
      name,
      ok: false,
      detail: `${found.length} simulators share the name: ${found.map((d) => d.udid).join(', ')}`,
      fix: 'Delete all but one: xcrun simctl delete <udid>',
    };
  }
  const runtime = found[0].runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '');
  return { name, ok: true, detail: `${found[0].udid} (${runtime})` };
}

export function runDoctor(exec: Exec, env: NodeJS.ProcessEnv, fontDir: string): Check[] {
  return [
    checkNode(process.versions.node),
    checkXcodebuild(exec),
    checkSimctl(exec),
    checkFfmpeg(exec, env),
    checkFonts(fontDir),
    checkSimulator(exec),
  ];
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.flatMap((c) => [
    `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`,
    ...(c.fix ? [`    fix: ${c.fix}`] : []),
  ]);
  const failed = checks.filter((c) => !c.ok).length;
  lines.push('', failed ? `${failed} of ${checks.length} checks failed.` : 'All checks passed.');
  return lines.join('\n');
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim())?.trim() ?? '';
}
