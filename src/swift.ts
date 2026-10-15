/** What a demo can find a SwiftUI element by: its identifier or the text it shows. */
export type Found = { kind: string; value: string; line: number };

const literal = '"((?:[^"\\\\\\n]|\\\\.)*)"';
const patterns: [string, RegExp][] = [
  'accessibilityIdentifier', 'accessibilityLabel', 'navigationTitle', 'Text', 'Button', 'Label', 'Toggle',
  'TextField', 'SecureField', 'Picker', 'Section', 'Tab', 'NavigationLink', 'Stepper', 'DatePicker', 'alert',
  'confirmationDialog',
].map((name) => [name, new RegExp(`(?:^|[^\\w.])\\.?${name}\\(\\s*${literal}`, 'g')]);

/** The identifiers and visible strings in Swift source, in order, each once per kind. */
export function swiftStrings(source: string): Found[] {
  const found: Found[] = [];
  const seen = new Set<string>();
  source.split('\n').forEach((text, i) => {
    if (/^\s*\/\//.test(text)) return;
    const hits: (Found & { at: number })[] = [];
    for (const [kind, re] of patterns) {
      for (const m of text.matchAll(re)) hits.push({ kind, value: m[1], line: i + 1, at: m.index });
    }
    for (const { at, ...hit } of hits.sort((a, b) => a.at - b.at)) {
      const key = `${hit.kind}\0${hit.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push(hit);
      }
    }
  });
  return found;
}

/** The index of the brace closing the one at `open`, skipping strings and comments. */
function closingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (ch === '/' && src[i + 1] === '*') i = src.indexOf('*/', i + 2) === -1 ? src.length : src.indexOf('*/', i + 2) + 1;
    else if (ch === '"') {
      const triple = src.startsWith('"""', i);
      if (triple) i = src.indexOf('"""', i + 3) === -1 ? src.length : src.indexOf('"""', i + 3) + 2;
      else for (i++; i < src.length && src[i] !== '"' && src[i] !== '\n'; i++) if (src[i] === '\\') i++;
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The file with the body of each `func test…` cut to one comment line, except tests with a line
 * in `keep` (line numbers from 1): the helpers and the tests a change touched stay whole.
 */
export function elideTests(source: string, keep: Set<number>): { text: string; elided: number } {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const cuts: [number, number, number][] = []; // [first body line, last body line, indent]
  for (const m of source.matchAll(/^([ \t]*)(?:(?:@\w+|private|public|internal|final|override|static)\s+)*func test\w*\s*\(/gm)) {
    const open = source.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    const close = closingBrace(source, open);
    if (close === -1) continue;
    const first = lineAt(open) + 1, last = lineAt(close) - 1;
    if (last < first) continue;
    let touched = false;
    for (let l = lineAt(m.index); l <= last + 1; l++) if (keep.has(l)) touched = true;
    if (!touched) cuts.push([first, last, m[1].length]);
  }
  const lines = source.split('\n');
  for (const [first, last, indent] of cuts.reverse()) {
    lines.splice(first - 1, last - first + 1, `${' '.repeat(indent + 4)}// ${last - first + 1} lines not shown`);
  }
  return { text: lines.join('\n'), elided: cuts.length };
}
