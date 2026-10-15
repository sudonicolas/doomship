import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assColour, logoSvg, shapes, svgPath } from '../src/logo.ts';

test('assColour: BGR order, alpha from opacity, lowercase tags', () => {
  assert.equal(assColour('#F0302A', 1), '\\1c&H2A30F0&\\1a&H00&');
  assert.equal(assColour('#ff7f0a', 0.62), '\\1c&H0A7FFF&\\1a&H61&');
  assert.equal(assColour('#000000', 0), '\\1c&H000000&\\1a&HFF&');
  assert.throws(() => assColour('red', 1), /#RRGGBB/);
});

test('svgPath: m, l and b become M, L and C, closed', () => {
  assert.equal(svgPath('m 0 0 l 10 0 b 10 5 5 10 0 10'), 'M 0 0 L 10 0 C 10 5 5 10 0 10 Z');
});

test('every shape is a drawing inside the icon', () => {
  for (const s of shapes) {
    assert.match(s.path, /^m( -?[\d.]+){2}( [lb]( -?[\d.]+)+)+$/, s.name);
    const coords = s.path.split(' ').filter((t) => /\d/.test(t)).map(Number);
    assert.equal(coords.length % 2, 0, s.name);
    // Glows spill past their shape; everything sharp stays inside the icon.
    if (!s.blur) for (const c of coords) assert.ok(Math.abs(c) <= 500, `${s.name}: ${c}`);
  }
  assert.equal(shapes[0].name, 'icon');
});

test('the SVG in resources matches the paths', () => {
  const file = readFileSync(new URL('../resources/brand/doomship.svg', import.meta.url), 'utf8');
  assert.equal(file, logoSvg(), 'run: node src/logo.ts > resources/brand/doomship.svg');
});
