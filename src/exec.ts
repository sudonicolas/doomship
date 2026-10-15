import { spawnSync } from 'node:child_process';

export type ExecResult = { ok: boolean; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

/** Runs a command to completion. A missing command is a failed result, not a throw. */
export const exec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
