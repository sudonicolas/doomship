import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { slug } from '../change.ts';
import type { Events } from '../drivers/ios/record.ts';
import { exec } from '../exec.ts';
import { findFfmpeg } from '../ffmpeg.ts';
import { fontsDir } from '../fonts.ts';
import { moviesDir } from '../paths.ts';
import type { Run } from '../run.ts';
import { plan } from './plan.ts';

/** GitHub shows images up to 10 MB; this leaves room. */
export const sizeLimit = 9.5 * 1024 * 1024;
/** Tried in order until the GIF fits: the look first, then fewer frames, then narrower. */
export const landscapeLadder = [
  { width: 960, fps: 15 },
  { width: 960, fps: 12 },
  { width: 800, fps: 12 },
  { width: 640, fps: 12 },
];
export const ladder = [
  { width: 600, fps: 15 },
  { width: 600, fps: 12 },
  { width: 480, fps: 12 },
  { width: 400, fps: 12 },
];

export type Rendered = {
  gif: string; png: string; json: string; mp4?: string;
  duration: number; bytes: number; width: number; height: number; fps: number;
  captions: string[]; seconds: number;
};

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${basename(cmd)} failed: ${(r.stderr || r.error?.message || '').trim()}`);
}

function videoSize(ffprobe: string, video: string): { w: number; h: number } {
  const r = exec(ffprobe, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', video]);
  const [w, h] = r.stdout.trim().split('x').map(Number);
  if (!r.ok || !w || !h) throw new Error(`could not read the video's size: ${r.stderr.trim()}`);
  return { w, h };
}

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The output's name: <date>-<sha>-<slug>. */
export function outputName(r: Run, date = localDate(), viewport?: string): string {
  const sha = r.change.headCommit.slice(0, 7) + (r.change.head === 'worktree' ? '-worktree' : '');
  return `${date}-${sha}-${slug(r.change.title)}${viewport === 'desktop' ? '-desktop' : ''}`;
}

/** Renders the run's recording into the PR GIF, its poster and sidecar (and an MP4 when asked). */
export function render(r: Run, opts: { mp4?: boolean; splash?: boolean } = {}): Rendered {
  const splash = opts.splash ?? true;
  const started = Date.now();
  const video = join(r.dir, 'video.mov');
  const eventsFile = join(r.dir, 'events.json');
  if (!existsSync(video) || !existsSync(eventsFile)) throw new Error(`${r.dir}: no recording yet (video.mov and events.json); run doomship record`);
  const events = JSON.parse(readFileSync(eventsFile, 'utf8')) as Events & { viewport?: string };

  const ffmpeg = findFfmpeg(exec, process.env).path;
  if (!ffmpeg) throw new Error('no ffmpeg with libass: run doomship doctor');
  const ffprobe = ffmpeg.includes('/') ? join(dirname(ffmpeg), 'ffprobe') : 'ffprobe';
  const { w, h } = videoSize(ffprobe, video);
  // simctl's H.264 has B-frames whose decode times fall seconds behind their presentation times
  // over a long recording; ffmpeg then trusts the decode times and the video drifts from the
  // events. Ignoring them keeps each frame at its presentation time.
  const input = ['-fflags', '+igndts', '-i', video];

  // The graph reads the fonts as fonts/, so no path in it needs quoting.
  const fontsLink = join(r.dir, 'fonts');
  rmSync(fontsLink, { force: true, recursive: true });
  symlinkSync(fontsDir, fontsLink);

  const out = moviesDir(r.repoName);
  mkdirSync(out, { recursive: true });
  const name = outputName(r, undefined, events.viewport);
  const steps = w > h ? landscapeLadder : ladder;
  const gif = join(out, `${name}.gif`), png = join(out, `${name}.png`), json = join(out, `${name}.json`);

  let p, step;
  for (step of steps) {
    p = plan(events, w, h, { ...step, accent: r.config.accent, splash });
    writeFileSync(join(r.dir, 'render.ass'), p.ass);
    writeFileSync(join(r.dir, 'splash.ass'), p.splashAss);
    writeFileSync(join(r.dir, 'render.filter'), p.graph);
    run(ffmpeg, ['-v', 'error', '-y', ...input, '-/filter_complex', 'render.filter', '-map', '[v]',
      '-t', p.duration.toFixed(3), '-loop', '0', gif], r.dir);
    if (statSync(gif).size <= sizeLimit) break;
  }
  const bytes = statSync(gif).size;
  if (bytes > sizeLimit) throw new Error(`the GIF is ${(bytes / 1048576).toFixed(1)} MB even at ${step!.width} px and ${step!.fps} fps: shorten the demo`);
  // The poster: the result, the last frame before the end splash.
  run(ffmpeg, ['-v', 'error', '-y', '-ss', Math.max(0, p!.flowEnd - 0.1).toFixed(3), '-i', gif, '-frames:v', '1', '-update', '1', png], r.dir);

  let mp4: string | undefined;
  if (opts.mp4) {
    mp4 = join(out, `${name}.mp4`);
    const full = plan(events, w, h, { ...steps[0], accent: r.config.accent, splash });
    writeFileSync(join(r.dir, 'render.ass'), full.ass);
    writeFileSync(join(r.dir, 'splash.ass'), full.splashAss);
    writeFileSync(join(r.dir, 'render-mp4.filter'), full.mp4Graph);
    run(ffmpeg, ['-v', 'error', '-y', ...input, '-/filter_complex', 'render-mp4.filter', '-map', '[v]',
      '-t', full.duration.toFixed(3), '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', mp4], r.dir);
  }

  const rendered: Rendered = {
    gif, png, json, ...(mp4 && { mp4 }),
    duration: Math.round(p!.duration * 100) / 100, bytes, width: p!.outW, height: p!.outH, fps: step!.fps,
    captions: p!.captions.map((c) => c.text), seconds: (Date.now() - started) / 1000,
  };
  writeFileSync(json, JSON.stringify({
    commit: r.change.headCommit, base: r.change.base, change: r.change.spec, worktree: r.change.head === 'worktree',
    title: r.change.title, captions: rendered.captions, duration: rendered.duration, platform: r.config.platform,
    width: rendered.width, height: rendered.height, fps: rendered.fps, bytes,
    files: { gif: basename(gif), png: basename(png), ...(mp4 && { mp4: basename(mp4) }) },
  }, null, 2) + '\n');
  writeFileSync(join(r.dir, 'render.json'), JSON.stringify(rendered, null, 2) + '\n');
  return rendered;
}
