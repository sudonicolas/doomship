import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IosConfig } from '../../config.ts';
import { syncSource } from '../../prepare.ts';
import type { Run } from '../../run.ts';
import type { Build, Driver } from '../driver.ts';
import { inject } from './inject.ts';
import { recordIos } from './record.ts';
import { buildFailure, derivedData, readLog, runLogged, simulatorUdid, xcodebuildArgs } from './xcodebuild.ts';

/** Re-exports the run's tree (another run may have used src/ since), injects the demo and builds for testing. */
async function prepareBuild(run: Run): Promise<Build> {
  const config = run.config as IosConfig;
  const failureFile = join(run.dir, 'failure.txt');
  rmSync(failureFile, { force: true });
  syncSource(run.repo, run.change);
  const { layout } = inject(run);
  const log = join(run.dir, 'build.log');
  const args = ['build-for-testing', ...xcodebuildArgs(config, run.src, derivedData(run.repoName), simulatorUdid())];
  const r = await runLogged('xcodebuild', args, log);
  if (r.code === 0 && !r.stalled) return { ok: true, seconds: r.seconds };
  const failure = r.stalled
    ? `The build stalled: xcodebuild printed nothing for 240 s and was stopped. See build.log.\n`
    : buildFailure(readLog(log), run.src, config.injectInto, layout);
  writeFileSync(failureFile, failure);
  return { ok: false, seconds: r.seconds, failure };
}

export const iosDriver: Driver = {
  prepareBuild,
  record: recordIos,
};
