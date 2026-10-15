// The doomship logo: a white sailboat whose mainsail is a play button, crossing a red sun that sets
// into the sea behind it, on a dark squircle. One set of paths feeds both the renderer (ASS
// drawings) and the SVG, so the two can't drift apart.
//
// Icon units: the icon is 1000 x 1000 with its origin at the centre, y down.

import { fileURLToPath } from 'node:url';

/** One filled shape, drawn in order. */
export type Shape = {
  name: string;
  /** An ASS drawing: `m`, `l` and `b` (cubic) commands on absolute icon coordinates. */
  path: string;
  colour: string;
  /** 0 to 1. */
  opacity: number;
  /** Gaussian blur, in icon units (0 for a sharp edge). */
  blur: number;
  /** Nothing below this y is drawn: the sea the sun sets into. */
  clipBelow?: number;
};

type Point = [number, number];
const round = (n: number) => String(Math.round(n * 10) / 10);
const pt = ([x, y]: Point) => `${round(x)} ${round(y)}`;

// The sailboat is drawn on a 1000-unit grid of its own (origin top-left), then shrunk to 66% of the
// icon and set a little below its centre.
const glyphScale = 0.66;
const glyph = ([x, y]: Point): Point => [x * glyphScale - 330, y * glyphScale - 278];

/** A closed polygon with rounded corners (one radius per corner, or one for all). */
function roundedPolygon(points: Point[], radius: number | number[]): string {
  const n = points.length;
  const corners = points.map((v, i) => {
    const r = Array.isArray(radius) ? radius[i] : radius;
    const toward = (p: Point): Point => {
      const d = Math.hypot(p[0] - v[0], p[1] - v[1]);
      return [v[0] + ((p[0] - v[0]) * r) / d, v[1] + ((p[1] - v[1]) * r) / d];
    };
    const a = toward(points[(i + n - 1) % n]), b = toward(points[(i + 1) % n]);
    const pull = (p: Point): Point => [p[0] + (v[0] - p[0]) * 0.55, p[1] + (v[1] - p[1]) * 0.55];
    return { a, b, c1: pull(a), c2: pull(b) };
  });
  const out = [`m ${pt(corners[0].b)}`];
  for (let i = 1; i <= n; i++) {
    const c = corners[i % n];
    out.push(`l ${pt(c.a)}`, `b ${pt(c.c1)} ${pt(c.c2)} ${pt(c.b)}`);
  }
  return out.join(' ');
}

function circle([cx, cy]: Point, r: number): string {
  const k = r * 0.5523;
  return [
    `m ${pt([cx, cy - r])}`,
    `b ${pt([cx + k, cy - r])} ${pt([cx + r, cy - k])} ${pt([cx + r, cy])}`,
    `b ${pt([cx + r, cy + k])} ${pt([cx + k, cy + r])} ${pt([cx, cy + r])}`,
    `b ${pt([cx - k, cy + r])} ${pt([cx - r, cy + k])} ${pt([cx - r, cy])}`,
    `b ${pt([cx - r, cy - k])} ${pt([cx - k, cy - r])} ${pt([cx, cy - r])}`,
  ].join(' ');
}

/** An app-icon squircle: the superellipse |x|^4 + |y|^4 = r^4. */
function squircle(r: number, steps = 160): string {
  const points: Point[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    points.push([Math.sign(c) * r * Math.abs(c) ** 0.5, Math.sign(s) * r * Math.abs(s) ** 0.5]);
  }
  return `m ${pt(points[0])} ${points.slice(1).map((p) => `l ${pt(p)}`).join(' ')}`;
}

/** Applies a point mapping to every coordinate pair of an ASS drawing. */
function mapPath(path: string, f: (p: Point) => Point): string {
  return path.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, x, y) => pt(f([Number(x), Number(y)])));
}
const onGlyph = (path: string) => mapPath(path, glyph);
const scaled = (n: number) => n * glyphScale;

// Glyph grid: the mainsail (a play button on the mast), the jib, and a hull with a rounded stern
// on the left and a drawn-out bow on the right.
const mainsail = roundedPolygon([[478, 130], [478, 600], [858, 380]], 28);
const jib = roundedPolygon([[440, 250], [440, 600], [230, 600]], 16);
const hull = 'm 130 640 l 900 640 b 860 760 790 800 700 800 l 280 800 b 200 800 150 740 130 640';
const sun: Point = [500, 700];
const waterline = glyph([0, 790])[1];

export const ink = '#0D0F14';
export const red = '#F0302A';

export const shapes: Shape[] = [
  { name: 'icon', path: squircle(500), colour: ink, opacity: 1, blur: 0 },
  { name: 'sun glow', path: onGlyph(circle(sun, 340)), colour: '#FF3B30', opacity: 0.62, blur: scaled(220) },
  { name: 'sun', path: onGlyph(circle(sun, 300)), colour: red, opacity: 1, blur: 0, clipBelow: waterline },
  { name: 'sun warmth', path: onGlyph(circle([sun[0], sun[1] + 135], 210)), colour: '#FF7F0A', opacity: 0.81, blur: scaled(250), clipBelow: waterline },
  { name: 'mainsail', path: onGlyph(mainsail), colour: '#FFFFFF', opacity: 1, blur: 0 },
  { name: 'jib', path: onGlyph(jib), colour: '#FFFFFF', opacity: 1, blur: 0 },
  { name: 'hull', path: onGlyph(hull), colour: '#FFFFFF', opacity: 1, blur: 0 },
];

/** `#RRGGBB` and an opacity as ASS colour and alpha overrides (`\1c&HBBGGRR&\1a&HAA&`). */
export function assColour(hex: string, opacity: number): string {
  const m = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/.exec(hex.toUpperCase());
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const alpha = Math.round((1 - opacity) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `\\1c&H${m[3]}${m[2]}${m[1]}&\\1a&H${alpha}&`;
}

/** An ASS drawing as an SVG path. */
export function svgPath(path: string): string {
  return path.replace(/\bm\b/g, 'M').replace(/\bl\b/g, 'L').replace(/\bb\b/g, 'C') + ' Z';
}

/** The icon as a standalone SVG, `size` pixels square. */
export function logoSvg(size = 1024): string {
  const defs: string[] = [`<clipPath id="icon"><path d="${svgPath(shapes[0].path)}"/></clipPath>`];
  const body = shapes.map((s, i) => {
    const attrs = [`d="${svgPath(s.path)}"`, `fill="${s.colour}"`];
    if (s.opacity < 1) attrs.push(`fill-opacity="${s.opacity}"`);
    if (s.blur) {
      defs.push(`<filter id="blur${i}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${round(s.blur / 2)}"/></filter>`);
      attrs.push(`filter="url(#blur${i})"`);
    }
    if (s.clipBelow !== undefined) {
      defs.push(`<clipPath id="sea${i}"><rect x="-500" y="-500" width="1000" height="${round(s.clipBelow + 500)}"/></clipPath>`);
      attrs.push(`clip-path="url(#sea${i})"`);
    }
    return `    <path ${attrs.join(' ')}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-500 -500 1000 1000">
  <title>doomship</title>
  <defs>
    ${defs.join('\n    ')}
  </defs>
  <g clip-path="url(#icon)">
${body.join('\n')}
  </g>
</svg>
`;
}

// `node src/logo.ts` prints the SVG (resources/brand/doomship.svg).
if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(logoSvg());
