import type { Change } from './change.ts';
import type { Config } from './config.ts';
import type { FileDiff } from './diff.ts';
import { swiftStrings } from './swift.ts';

/** context.md's cap: the agent's only input, kept small enough to read whole. */
export const contextLimit = 60 * 1024;

/** One piece of context.md: fixed text, or a file the cap may cut. */
export type Part = { text: string } | { file: string; label: string; lang: string; body: string };

export type ContextInput = {
  change: Change;
  config: Config;
  /** The commits' full messages, oldest first. */
  messages: { sha: string; message: string }[];
  files: (FileDiff & { area: string | null })[];
  /** The changed files the agent should see in full: area "ui" (or every file, without one). */
  uiFiles: { path: string; source: string }[];
  /** The UI test file the demo goes into, with untouched tests elided; undefined if missing. */
  helpers?: { path: string; text: string; elided: number };
  src: string;
  run: string;
};

const fence = (lang: string, body: string) => {
  const ticks = body.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${body.replace(/\n?$/, '\n')}${ticks}`;
};
const langOf = (path: string) => ({ swift: 'swift', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', json: 'json', md: 'md' })[path.split('.').pop() ?? ''] ?? '';
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const size = (s: string) => Buffer.byteLength(s);

/** The parts of context.md, in order, before any cut. */
export function contextParts(c: ContextInput): Part[] {
  const { change, config } = c;
  const parts: Part[] = [];
  const text = (t: string) => parts.push({ text: t });

  const how = change.kind === 'worktree'
    ? `the working tree (uncommitted, untracked files included) against ${change.base.slice(0, 7)}`
    : `${change.head.slice(0, 7)} against ${change.base.slice(0, 7)}`;
  const launch = config.platform === 'ios' && config.launchArguments.length ? ` Launch arguments: ${config.launchArguments.join(' ')}.` : '';
  text(`# ${change.title}\n\nThe change: \`${change.spec}\` (${change.kind}), ${how}. Platform: ${config.platform}.${launch}\n` +
    `The exported tree is ${c.src}; the full diff is ${c.run}/diff.patch.`);

  text('## Commits');
  if (change.kind === 'worktree') text('Uncommitted changes: no commit message.');
  for (const m of c.messages) text(`### ${m.sha.slice(0, 7)}\n\n${m.message.trim()}`);

  const rows = c.files.map((f) => {
    const lines = f.binary ? 'binary' : `+${f.added} -${f.removed}`;
    const path = f.from ? `${f.from} → ${f.path}` : f.path;
    return `| ${f.status} | ${path} | ${lines} | ${f.area ?? ''} |`;
  });
  text(`## Changed files\n\n${c.files.length ? `| Status | File | Lines | Area |\n|---|---|---|---|\n${rows.join('\n')}` : 'None: the change has no file changes.'}`);
  const hasUiArea = 'ui' in config.areas;
  if (!c.uiFiles.length) {
    text(hasUiArea ? 'No changed file is in the ui area: nothing a user sees may have changed.' : 'No changed files to show.');
  }

  if (config.notes.length) text(`## Notes about the app\n\n${config.notes.map((n) => `- ${n}`).join('\n')}`);

  if (c.uiFiles.length) {
    const blocks = c.uiFiles.flatMap((f) => {
      const added = new Set(c.files.find((d) => d.path === f.path)?.addedLines);
      const found = f.path.endsWith('.swift') ? swiftStrings(f.source) : [];
      if (!found.length) return [];
      const lines = found.map((x) => `- ${x.kind}: "${x.value}"${added.has(x.line) ? ' (new)' : ''} (line ${x.line})`);
      return [`### ${f.path}\n\n${lines.join('\n')}`];
    });
    text(`## Identifiers and visible strings\n\nWhat a demo can find elements by, in the changed UI files. "(new)" marks lines this change added.`);
    if (blocks.length) text(blocks.join('\n\n'));
    else text('None found.');

    text(`## The diff of the UI files`);
    for (const f of c.files.filter((d) => c.uiFiles.some((u) => u.path === d.path))) {
      parts.push({ file: f.path, label: `diff of ${f.path}`, lang: 'diff', body: f.patch });
    }
    text(`## The changed UI files in full`);
    for (const f of c.uiFiles) parts.push({ file: f.path, label: f.path, lang: langOf(f.path), body: f.source });
  }

  if (c.helpers) {
    const note = c.helpers.elided ? ` The body of each test this change didn't touch is left out (${c.helpers.elided} tests).` : '';
    text(`## The UI tests the demo goes into\n\nThe demo is appended to ${c.helpers.path}, so it can use what this file shows. Its own tests are the best examples of driving the app.${note}`);
    parts.push({ file: c.helpers.path, label: c.helpers.path, lang: langOf(c.helpers.path), body: c.helpers.text });
  }
  return parts;
}

/**
 * Renders the parts under the cap: while too big, the largest file left whole is replaced by a
 * line saying where to read it, and a note at the top lists what was cut.
 */
export function renderContext(parts: Part[], src: string, limit = contextLimit): { text: string; cut: string[] } {
  const cutLabels: string[] = [];
  const cut = new Set<number>();
  const render = () => {
    const out = parts.map((p, i) => {
      if ('text' in p) return p.text;
      const head = `### ${p.label}`;
      return cut.has(i)
        ? `${head}\n\nCut to keep this file under ${limit / 1024} KB (${kb(size(p.body))}). Read ${src}/${p.file}.`
        : `${head}\n\n${fence(p.lang, p.body)}`;
    });
    if (cutLabels.length) out.splice(1, 0, `**Cut to fit:** ${cutLabels.join(', ')}. Each says where to read it.`);
    return out.join('\n\n') + '\n';
  };
  let text = render();
  while (size(text) > limit) {
    let largest = -1;
    parts.forEach((p, i) => {
      if ('body' in p && !cut.has(i) && (largest === -1 || size(p.body) > size((parts[largest] as { body: string }).body))) largest = i;
    });
    if (largest === -1) break;
    cut.add(largest);
    cutLabels.push((parts[largest] as { label: string }).label);
    text = render();
  }
  if (size(text) > limit) {
    const note = `\n\n**Cut here:** the rest is over ${limit / 1024} KB.\n`;
    const buf = Buffer.from(text).subarray(0, limit - size(note));
    text = buf.toString('utf8').replace(/�$/, '') + note;
    cutLabels.push('the end');
  }
  return { text, cut: cutLabels };
}
