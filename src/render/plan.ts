// The PR GIF, planned from a recording's events: which stretches play and how fast, where the
// captions, tap rings and spotlights go, as an ASS subtitle file and an ffmpeg filter graph. Pure:
// the same events give the same files (test/golden/). Look and timing from the first prototype.
import type { Event, Events } from '../drivers/ios/record.ts';

export type RenderOptions = {
  /** The GIF's width; shown at half this in a PR. Every size was tuned at 600 and scales with it. */
  width: number;
  fps: number;
  /** The band's colour, #RRGGBB. */
  accent: string;
};

export type Segment = { from: number; to: number; speed: number };
export type Spotlight = { a: number; b: number; zoom: number; x0: number; y0: number; x: number; y: number; ew: number; eh: number };
export type Caption = { text: string; start: number; end: number };
export type Plan = {
  ass: string;
  /** The filter graph: the recording is [0:v]; render.ass and fonts/ are read from the working directory; output [v]. */
  graph: string;
  /** The same, for an MP4 (no palette); output [v]. */
  mp4Graph: string;
  duration: number;
  outW: number;
  outH: number;
  segments: Segment[];
  spotlights: Spotlight[];
  captions: Caption[];
};

/** Seconds after a tap's t0 that its touch-down shows on screen (measured on the spike video). */
export const tapLag = 0.15;
/** Seconds a spotlight takes to zoom in, and again to zoom out. */
export const zoomRamp = 0.3;
/** Idle stretches longer than this keep half a second at each end and play the middle at 4x. */
export const idleLimit = 1.5;
export const idleSpeed = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const f = (n: number) => n.toFixed(1);

/** The flow from begin to end, cut into stretches that play at 1x and idle ones sped up. */
export function segmentsOf(events: Event[]): Segment[] {
  const begin = events.find((e) => e.event === 'begin')!;
  const end = events.find((e) => e.event === 'end')!;
  // Busy: holds and spotlights, taps (touch-down to 0.6 s after the call returns), captions.
  const busy = events.map((e): [number, number] => {
    if (e.event === 'hold' || e.event === 'show') return [e.t, e.t + (e.seconds ?? 0)];
    if (e.event === 'tap') return [e.t0 ?? e.t, e.t + 0.6];
    return [e.t, e.t + 0.8];
  }).sort((a, b) => a[0] - b[0]);
  const segments: Segment[] = [];
  let stretch = begin.t; // where the current real-time stretch began
  let cursor = stretch; // the end of the busy time so far
  for (const [a, b] of busy) {
    if (a - cursor > idleLimit) {
      segments.push({ from: stretch, to: cursor + 0.5, speed: 1 }, { from: cursor + 0.5, to: a - 0.5, speed: idleSpeed });
      stretch = a - 0.5;
    }
    cursor = Math.max(cursor, Math.min(b, end.t));
  }
  segments.push({ from: stretch, to: end.t, speed: 1 });
  return segments.filter((s) => s.to > s.from).reduce<Segment[]>((acc, s) => {
    const last = acc.at(-1);
    if (last && last.speed === s.speed && Math.abs(last.to - s.from) < 1e-6) last.to = s.to;
    else acc.push({ ...s });
    return acc;
  }, []);
}

/** Video seconds to GIF seconds. */
export function mapTime(segments: Segment[], s: number): number {
  let out = 0;
  for (const seg of segments) {
    if (s <= seg.to) return out + Math.max(0, s - seg.from) / seg.speed;
    out += (seg.to - seg.from) / seg.speed;
  }
  return out;
}

/**
 * Each caption from its marker to the next caption, the last to the end. A caption logged within
 * 1.5 s of a tap describes the screen that tap opened (the demo waited for it), so it starts 0.3 s
 * after the tap, as the new screen slides in.
 */
export function captionsOf(events: Event[], segments: Segment[], duration: number): Caption[] {
  const captions = events.filter((e) => e.event === 'caption');
  const start = (c: Event) => {
    const before = events[events.indexOf(c) - 1];
    return before?.event === 'tap' && c.t - before.t < 1.5 ? before.t + 0.3 : c.t;
  };
  return captions.map((c, i) => ({
    text: c.text ?? '',
    start: mapTime(segments, start(c)),
    end: i + 1 < captions.length ? mapTime(segments, start(captions[i + 1])) : duration,
  }));
}

const assTime = (x: number) => {
  const cs = Math.max(0, Math.round(x * 100));
  const hh = Math.floor(cs / 360000), mm = Math.floor(cs / 6000) % 60, ss = Math.floor(cs / 100) % 60;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
/** Braces and backslashes would start ASS tags. */
const assText = (text: string) => text.replace(/[{}\\]/g, '');

export function plan(events: Events, srcW: number, srcH: number, o: RenderOptions): Plan {
  const ev = events.events;
  const begin = ev.find((e) => e.event === 'begin')!;
  const end = ev.find((e) => e.event === 'end')!;
  const outW = o.width;
  const scale = outW / srcW;
  const screenH = 2 * Math.round((srcH * scale) / 2);
  const u = outW / 600;
  const bandH = 2 * Math.round((128 * u) / 2);
  const outH = screenH + bandH;
  const pointScale = srcW / (begin.w ?? srcW); // source pixels per point
  const accentHex = o.accent.replace('#', '').toUpperCase();
  const accentAss = `&H00${accentHex.slice(4, 6)}${accentHex.slice(2, 4)}${accentHex.slice(0, 2)}`;

  const segments = segmentsOf(ev);
  const at = (t: number) => mapTime(segments, t);
  const duration = at(end.t);

  // Spotlights, in source pixels (zoompan crops the full-size recording, so a zoom stays sharp):
  // the element about half the screen's width, at most 2.2x; in, hold, out. Times in GIF seconds.
  const spotlights: Spotlight[] = ev.filter((e) => e.event === 'show').map((e) => {
    const a = at(e.t), b = at(e.t + (e.seconds ?? 1.5));
    const x = (e.x ?? 0) * pointScale, y = (e.y ?? 0) * pointScale;
    const ew = Math.max(1, (e.w ?? 0) * pointScale), eh = Math.max(1, (e.h ?? 0) * pointScale);
    const zoom = clamp(Math.min((0.5 * srcW) / ew, (0.3 * srcH) / eh), 1.2, 2.2);
    const x0 = clamp(x + ew / 2 - srcW / (2 * zoom), 0, srcW - srcW / zoom);
    const y0 = clamp(y + eh / 2 - srcH / (2 * zoom), 0, srcH - srcH / zoom);
    return { a, b, zoom, x0, y0, x, y, ew, eh };
  });
  const smooth = (p: number) => p * p * (3 - 2 * p);
  /** How far into its zoom a spotlight is at GIF time t, 0 to 1. */
  const weightAt = (s: Spotlight, t: number) => smooth(clamp((t - s.a) / zoomRamp, 0, 1)) - smooth(clamp((t - (s.b - zoomRamp)) / zoomRamp, 0, 1));
  /** Source pixels to GIF pixels at time t, through any zoom. */
  const project = (x: number, y: number, t: number) => {
    let z = 1, ox = 0, oy = 0;
    for (const s of spotlights) {
      const w = weightAt(s, t);
      z += (s.zoom - 1) * w; ox += s.x0 * w; oy += s.y0 * w;
    }
    return { x: (x - ox) * z * scale, y: bandH + (y - oy) * z * scale };
  };

  const lines: string[] = [];
  const dialog = (layer: number, a: number, b: number, style: string, text: string) =>
    lines.push(`Dialogue: ${layer},${assTime(a)},${assTime(b)},${style},,0,0,0,,${text}`);

  const captions = captionsOf(ev, segments, duration);
  for (const c of captions) dialog(1, c.start, c.end, 'Caption', `{\\an5\\pos(${outW / 2},${bandH / 2})}${assText(c.text)}`);

  // Tap rings: a circle that grows and fades where the touch landed (through a zoom, if one is on).
  const r = 34 * u, k = r * 0.5523;
  const circle = `m 0 ${f(-r)} b ${f(k)} ${f(-r)} ${f(r)} ${f(-k)} ${f(r)} 0 b ${f(r)} ${f(k)} ${f(k)} ${f(r)} 0 ${f(r)} ` +
    `b ${f(-k)} ${f(r)} ${f(-r)} ${f(k)} ${f(-r)} 0 b ${f(-r)} ${f(-k)} ${f(-k)} ${f(-r)} 0 ${f(-r)}`;
  for (const tap of ev.filter((e) => e.event === 'tap')) {
    const t = at((tap.t0 ?? tap.t) + tapLag);
    const p = project((tap.x ?? 0) * pointScale, (tap.y ?? 0) * pointScale, t);
    dialog(3, t, t + 0.5, 'Ring', `{\\an5\\pos(${f(p.x)},${f(p.y)})\\fscx80\\fscy80\\t(0,300,\\fscx115\\fscy115)\\fad(40,220)\\p1}${circle}{\\p0}`);
  }

  // Spotlight outlines: a rounded rectangle around the element, in zoomed coordinates, while the zoom holds.
  for (const s of spotlights) {
    const pad = 15 * u, z = s.zoom * scale;
    const left = (s.x - s.x0) * z - pad, top = bandH + (s.y - s.y0) * z - pad;
    const W = s.ew * z + 2 * pad, H = s.eh * z + 2 * pad, R = Math.min(22 * u, H / 2);
    const rect = `m ${f(R)} 0 l ${f(W - R)} 0 b ${f(W)} 0 ${f(W)} 0 ${f(W)} ${f(R)} l ${f(W)} ${f(H - R)} ` +
      `b ${f(W)} ${f(H)} ${f(W)} ${f(H)} ${f(W - R)} ${f(H)} l ${f(R)} ${f(H)} b 0 ${f(H)} 0 ${f(H)} 0 ${f(H - R)} ` +
      `l 0 ${f(R)} b 0 0 0 0 ${f(R)} 0`;
    dialog(3, s.a + zoomRamp, s.b - zoomRamp, 'Spot', `{\\an7\\pos(${f(left)},${f(top)})\\fad(100,100)\\p1}${rect}{\\p0}`);
  }

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${outW}
PlayResY: ${outH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Inter ExtraBold,${f(38 * u)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,${f(28 * u)},${f(28 * u)},0,1
Style: Ring,Inter ExtraBold,20,&H8C202020,&H00FFFFFF,&H10FFFFFF,&HA0000000,0,0,0,0,100,100,0,0,1,${f(4 * u)},${f(2 * u)},5,0,0,0,1
Style: Spot,Inter ExtraBold,20,&HFF000000,&H00FFFFFF,${accentAss},&H00000000,0,0,0,0,100,100,0,0,1,${f(5 * u)},0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;

  // The graph: constant frame rate first (the recording only has frames when the screen changes),
  // held past its end; the flow's stretches at full size; zoompan crops the spotlights and scales to
  // the GIF's width; the band on top; the text; then (GIF) a palette from the whole clip.
  const ease = (p: string) => `(${p})*(${p})*(3-2*(${p}))`;
  const weight = (s: Spotlight) =>
    `(${ease(`clip((it-${s.a.toFixed(3)})/${zoomRamp},0,1)`)}-${ease(`clip((it-${(s.b - zoomRamp).toFixed(3)})/${zoomRamp},0,1)`)})`;
  const fit = spotlights.length
    ? `zoompan=z='1${spotlights.map((s) => `+${(s.zoom - 1).toFixed(3)}*${weight(s)}`).join('')}'` +
      `:x='0${spotlights.map((s) => `+${s.x0.toFixed(1)}*${weight(s)}`).join('')}'` +
      `:y='0${spotlights.map((s) => `+${s.y0.toFixed(1)}*${weight(s)}`).join('')}'` +
      `:d=1:s=${outW}x${screenH}:fps=30`
    : `scale=${outW}:${screenH}:flags=lanczos`;
  const body = [
    `[0:v]fps=30,tpad=stop_mode=clone:stop_duration=5,split=${segments.length}${segments.map((_, i) => `[p${i}]`).join('')}`,
    ...segments.map((p, i) => `[p${i}]trim=start=${p.from.toFixed(3)}:end=${p.to.toFixed(3)},setpts=(PTS-STARTPTS)/${p.speed}[s${i}]`),
    `${segments.map((_, i) => `[s${i}]`).join('')}concat=n=${segments.length}:v=1:a=0,fps=30,${fit},` +
      `pad=${outW}:${outH}:0:${bandH}:color=0x${accentHex},` +
      `subtitles=render.ass:fontsdir=fonts`,
  ];
  const graph = [...body.slice(0, -1), `${body.at(-1)},fps=${o.fps},split[a][b]`,
    `[a]palettegen=stats_mode=diff[pal]`,
    `[b][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[v]`].join(';\n') + '\n';
  const mp4Graph = [...body.slice(0, -1), `${body.at(-1)},format=yuv420p[v]`].join(';\n') + '\n';

  return { ass, graph, mp4Graph, duration, outW, outH, segments, spotlights, captions };
}
