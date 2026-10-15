import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Events } from '../src/drivers/ios/record.ts';
import { captionsOf, mapTime, plan, segmentsOf } from '../src/render/plan.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const options = { width: 600, fps: 15, accent: '#5856D6', splash: false };
/** The iPhone 17 recording size, 3 px per point. */
const W = 1206, H = 2622;

/** Compares with test/golden/<name>; UPDATE_GOLDEN=1 rewrites it. */
function golden(name: string, actual: string) {
  const file = here(`golden/${name}`);
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, actual);
  assert.equal(actual, readFileSync(file, 'utf8'), `${name} differs; UPDATE_GOLDEN=1 if the change is wanted`);
}

/** A demo with a caption after a tap, a long idle wait, and a tap during a spotlight. */
const synthetic: Events = {
  videoStart: 0,
  events: [
    { event: 'begin', t: 1, w: 402, h: 874 },
    { event: 'caption', t: 1, text: 'Open Settings' },
    { event: 'tap', t0: 2, t: 2.4, x: 100, y: 200 },
    { event: 'caption', t: 2.9, text: 'Pick your training days' },
    { event: 'tap', t0: 8, t: 8.3, x: 201, y: 500 },
    { event: 'show', t: 9, x: 300, y: 60, w: 60, h: 36, seconds: 1.5 },
    { event: 'tap', t0: 9.5, t: 9.8, x: 330, y: 78 },
    { event: 'caption', t: 10.5, text: 'Saved for every week' },
    { event: 'hold', t: 10.6, seconds: 1.5 },
    { event: 'end', t: 12.2 },
  ],
};

test('speed-ups: idle stretches over 1.5 s keep 0.5 s each side and play at 4x', () => {
  const segments = segmentsOf(synthetic.events);
  assert.deepEqual(segments.map((s) => [s.from, Number(s.to.toFixed(3)), s.speed]), [[1, 4.2, 1], [4.2, 7.5, 4], [7.5, 12.2, 1]]);
  assert.equal(mapTime(segments, 12.2).toFixed(3), '8.725');
  assert.equal(mapTime(segments, 7.5).toFixed(3), '4.025');
});

test('a caption logged just after a tap starts 0.3 s after it, with the new screen', () => {
  const segments = segmentsOf(synthetic.events);
  const captions = captionsOf(synthetic.events, segments, 8.725);
  assert.deepEqual(captions.map((c) => [c.text, Number(c.start.toFixed(3)), Number(c.end.toFixed(3))]), [
    ['Open Settings', 0, 1.7],
    ['Pick your training days', 1.7, 6.625],
    ['Saved for every week', 6.625, 8.725],
  ]);
});

test('the screen at the GIF width under the caption band', () => {
  const p = plan(synthetic, W, H, options);
  assert.equal(p.outW, 600);
  assert.equal(p.outH, 1304 + 128);
  assert.match(p.graph, /:d=1:s=600x1304:fps=30,pad=600:1432:0:128:color=0x5856D6,subtitles=render\.ass:fontsdir=fonts,fps=15/);
  assert.match(p.ass, /^PlayResX: 600\nPlayResY: 1432$/m);
  assert.match(p.ass, /Caption,,0,0,0,,\{\\an5\\pos\(300,64\)\}Open Settings$/m);
  const narrow = plan(synthetic, W, H, { ...options, width: 400 });
  assert.equal(narrow.outH, 870 + 86);
  assert.match(narrow.graph, /s=400x870:fps=30,pad=400:956:0:86/);
});

test('tap rings land where the touch did, through a zoom when one is on', () => {
  const p = plan(synthetic, W, H, options);
  const rings = [...p.ass.matchAll(/Ring,,0,0,0,,\{\\an5\\pos\(([\d.]+),([\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  // Unzoomed: points x 3 px x 600/1206, plus the band.
  assert.deepEqual(rings[0], [149.3, 128 + 298.5]);
  assert.deepEqual(rings[1], [300, 128 + 746.3]);
  // During the spotlight the tap at (330, 78) pt is magnified about the zoomed view.
  const s = p.spotlights[0];
  const expected = [(330 * 3 - s.x0) * s.zoom * 600 / 1206, 128 + (78 * 3 - s.y0) * s.zoom * 600 / 1206].map((v) => Number(v.toFixed(1)));
  assert.deepEqual(rings[2], expected);
});

test('spotlights zoom on the element, at most 2.2x, with an outline while the zoom holds', () => {
  const p = plan(synthetic, W, H, options);
  assert.equal(p.spotlights.length, 1);
  assert.equal(p.spotlights[0].zoom, 2.2);
  assert.match(p.graph, /zoompan=z='1\+1\.200\*/);
  assert.equal([...p.ass.matchAll(/,Spot,/g)].length, 1);
  assert.match(p.ass, /^Style: Spot,Inter ExtraBold,20,&HFF000000,&H00FFFFFF,&H00D65658,/m);
});

test('golden: the spike recording plans exactly as the 0.5 GIF did', () => {
  const events = JSON.parse(readFileSync(here('fixtures/spike-89cd1d6.events.json'), 'utf8')) as Events;
  const p = plan(events, W, H, options);
  assert.equal(p.duration.toFixed(3), '11.102');
  golden('spike-89cd1d6.ass', p.ass);
  golden('spike-89cd1d6.filter', p.graph);
  golden('spike-89cd1d6.mp4.filter', p.mp4Graph);
});

test('golden: the synthetic demo', () => {
  const p = plan(synthetic, W, H, options);
  golden('synthetic.ass', p.ass);
  golden('synthetic.filter', p.graph);
});

test('the splash: the flow starts after it, the end splash follows the result, and the poster is the result', () => {
  const p = plan(synthetic, W, H, { ...options, splash: true });
  const bare = plan(synthetic, W, H, options);
  assert.equal(p.flowEnd.toFixed(3), (bare.duration + 1).toFixed(3));
  assert.equal(p.duration.toFixed(3), (bare.duration + 3).toFixed(3));
  // Captions are shifted by the start splash; the first is there from 0, under it; the last lasts to the end.
  assert.deepEqual(p.captions.map((c) => [Number(c.start.toFixed(3)), Number(c.end.toFixed(3))]), [[0, 2.7], [2.7, 7.625], [7.625, 11.725]]);
  // Spotlights and taps move with the flow.
  assert.equal((p.spotlights[0].a - bare.spotlights[0].a).toFixed(3), '1.000');
  // The first frame is held for the start splash, the last for the end one; blur and logo only while the splash is on.
  assert.match(p.graph, /\[p0\]trim=start=1\.000:end=4\.200,setpts=\(PTS-STARTPTS\)\/1,tpad=start_mode=clone:start=30\[s0\]/);
  assert.match(p.graph, /setpts=\(PTS-STARTPTS\)\/1,tpad=stop_mode=clone:stop=60\[s2\]/);
  assert.match(p.graph, /enable='not\(between\(t,1\.000,9\.725\)\)'/);
  assert.match(p.graph, /subtitles=render\.ass:fontsdir=fonts,split=2\[clear\]\[dim\];.*subtitles=splash\.ass:fontsdir=fonts,fps=15/s);
  // The start splash is finished and fades out; the end splash builds and holds to the end.
  assert.match(p.splashAss, /^Dialogue: 20,0:00:00\.00,0:00:01\.00,Wordmark,.*\\fad\(0,300\)\}doomship$/m);
  assert.match(p.splashAss, /^Dialogue: 20,0:00:10\.03,0:00:11\.73,Wordmark,.*\\move\(/m);
  assert.equal(bare.splashAss, '');
});

test('golden: the spike recording with the splash', () => {
  const events = JSON.parse(readFileSync(here('fixtures/spike-89cd1d6.events.json'), 'utf8')) as Events;
  const p = plan(events, W, H, { ...options, splash: true });
  assert.equal(p.duration.toFixed(3), '14.102');
  golden('spike-89cd1d6.splash.ass', p.splashAss);
  golden('spike-89cd1d6.splash.filter', p.graph);
});
