import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Change } from './change.ts';
import { loadConfig, type Config } from './config.ts';

/** A prepared run, read back from its run.json: everything a driver needs. */
export type Run = {
  dir: string;
  repo: string;
  repoName: string;
  src: string;
  change: Change;
  config: Config;
};

export function loadRun(dirArg: string): Run {
  const dir = resolve(dirArg);
  const file = join(dir, 'run.json');
  if (!existsSync(file)) throw new Error(`${dir}: not a run (no run.json); make one with doomship prepare`);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Omit<Run, 'dir' | 'config'> & { config: string };
  return { ...saved, dir, config: loadConfig(saved.repo, saved.config) };
}
