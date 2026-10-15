import type { Run } from '../run.ts';

/** A build of the run's demo. On failure, `failure` is what failure.txt says. */
export type Build = { ok: boolean; seconds: number; failure?: string };

/**
 * A recording of the demo. `video` and `events` are paths in the run; `failure` is set when the
 * demo failed or stalled, with what failure.txt says.
 */
export type Recording = { video: string; events: string; failure?: string; stalled?: boolean };

/**
 * What a platform does: put the run's demo into the exported tree and build it, then run it while
 * recording the screen. Everything after the recording (render, post) is the same for every
 * platform, driven by events.json.
 */
export interface Driver {
  prepareBuild(run: Run): Promise<Build>;
  record(run: Run): Promise<Recording>;
}
