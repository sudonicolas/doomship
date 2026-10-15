import type { Exec } from './exec.ts';

/**
 * Where to look for ffmpeg, in order. Homebrew's plain `ffmpeg` is built without libass, so the
 * keg-only `ffmpeg-full` comes before whatever is on PATH.
 */
export function ffmpegCandidates(env: NodeJS.ProcessEnv): string[] {
  const list = [
    env.DOOMSHIP_FFMPEG,
    '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
    '/usr/local/opt/ffmpeg-full/bin/ffmpeg',
    'ffmpeg',
  ];
  return list.filter((p): p is string => Boolean(p));
}

export function hasSubtitlesFilter(filtersOutput: string): boolean {
  return /^\s*\S+\s+subtitles\s/m.test(filtersOutput);
}

export type FfmpegSearch = {
  /** The first ffmpeg that has the subtitles filter. */
  path?: string;
  /** ffmpegs that run but were built without libass. */
  withoutLibass: string[];
};

export function findFfmpeg(exec: Exec, env: NodeJS.ProcessEnv = process.env): FfmpegSearch {
  const withoutLibass: string[] = [];
  for (const candidate of ffmpegCandidates(env)) {
    const r = exec(candidate, ['-hide_banner', '-filters']);
    if (!r.ok) continue;
    if (hasSubtitlesFilter(r.stdout)) return { path: candidate, withoutLibass };
    withoutLibass.push(candidate);
  }
  return { withoutLibass };
}
