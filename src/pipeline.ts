import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { iosDriver } from './drivers/ios/index.ts';
import type { Driver } from './drivers/driver.ts';
import type { Rendered } from './render/index.ts';
import type { Run } from './run.ts';

/** One try at recording: a build, then (if it built) the demo run. Appended to attempts.jsonl. */
export type Attempt = { buildSeconds: number; recordSeconds?: number; outcome: 'recorded' | 'build failed' | 'demo failed' | 'stalled'; failure?: string };

export function driverFor(run: Run): Driver {
  if (run.config.platform === 'ios') return iosDriver;
  throw new Error(`no ${run.config.platform} driver yet (Phase 3)`);
}

export function attemptsOf(run: Run): Attempt[] {
  const file = join(run.dir, 'attempts.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** Builds and records the run's demo, logging the attempt. */
export async function recordRun(run: Run): Promise<Attempt> {
  const driver = driverFor(run);
  const b = await driver.prepareBuild(run);
  let attempt: Attempt;
  if (!b.ok) {
    attempt = { buildSeconds: b.seconds, outcome: 'build failed', failure: b.failure };
  } else {
    const started = Date.now();
    const r = await driver.record(run);
    const recordSeconds = (Date.now() - started) / 1000;
    attempt = r.failure
      ? { buildSeconds: b.seconds, recordSeconds, outcome: r.stalled ? 'stalled' : 'demo failed', failure: r.failure }
      : { buildSeconds: b.seconds, recordSeconds, outcome: 'recorded' };
  }
  appendFileSync(join(run.dir, 'attempts.jsonl'), JSON.stringify(attempt) + '\n');
  return attempt;
}

/** Marks the run as having nothing to show, with the reason. */
export function skipRun(run: Run, reason: string): void {
  if (!reason.trim()) throw new Error('a skip needs a reason, such as "Only the preset data model changed; nothing on screen."');
  writeFileSync(join(run.dir, 'skip.json'), JSON.stringify({ change: run.change.spec, title: run.change.title, reason: reason.trim() }, null, 2) + '\n');
  rmSync(join(run.dir, 'demo.swift'), { force: true });
}

const s = (n: number | undefined) => (n === undefined ? '-' : `${n.toFixed(1)} s`);

/** What `doomship run` prints when it has a GIF. */
export function summary(run: Run, attempts: Attempt[], g: Rendered, tilde: (p: string) => string = (p) => p): string {
  const last = attempts.at(-1);
  return [
    `${run.change.title}`,
    `  gif:      ${tilde(g.gif)}`,
    `  length:   ${g.duration.toFixed(1)} s, ${g.captions.length} captions`,
    `  size:     ${(g.bytes / 1048576).toFixed(1)} MB, ${g.width}×${g.height} at ${g.fps} fps`,
    `  attempts: ${attempts.length}`,
    `  times:    build ${s(last?.buildSeconds)}, record ${s(last?.recordSeconds)}, render ${s(g.seconds)}`,
  ].join('\n');
}
