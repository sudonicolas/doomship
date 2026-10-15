import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../../git.ts';
import type { IosConfig } from '../../config.ts';
import type { Run } from '../../run.ts';

export const helperFile = fileURLToPath(new URL('../../../resources/ios/Doomship.swift', import.meta.url));
/** The test class and method a demo defines; xcodebuild runs only this. */
export const demoClass = 'Doomship';
export const demoMethod = 'testDemo';

/** The file as the change has it: from the commit, or from the working tree for uncommitted changes. */
export function originalSource(run: Run, path: string): string {
  if (run.change.head === 'worktree') {
    const file = join(run.repo, path);
    if (!existsSync(file)) throw new Error(`${path}: not in the working tree, so the demo has nowhere to go (injectInto)`);
    return readFileSync(file, 'utf8');
  }
  const r = git(run.repo, ['show', `${run.change.head}:${path}`]);
  if (!r.ok) throw new Error(`${path}: not in ${run.change.head.slice(0, 7)}, so the demo has nowhere to go (injectInto)`);
  return r.stdout;
}

/** Where each part of the injected file starts, so a compile error can be traced to its source. */
export type Layout = { helperStart: number; demoStart: number };

const withNewline = (s: string) => (s.endsWith('\n') ? s : s + '\n');
const lineCount = (s: string) => s.split('\n').length - 1;

/** The original file, then the helper, then the demo, each after a blank line. */
export function injected(original: string, helper: string, demo: string): { text: string; layout: Layout } {
  const head = withNewline(original) + '\n';
  const middle = withNewline(helper) + '\n';
  return {
    text: head + middle + withNewline(demo),
    layout: { helperStart: lineCount(head) + 1, demoStart: lineCount(head) + lineCount(middle) + 1 },
  };
}

/**
 * Writes the run's demo.swift, after the helper, into a fresh copy of `injectInto` in src/. The
 * file is rebuilt from the original each time, so attempts never stack, and left alone when it
 * already has these contents, so an unchanged demo doesn't rebuild.
 */
export function inject(run: Run): { path: string; layout: Layout; changed: boolean } {
  const config = run.config as IosConfig;
  const demoFile = join(run.dir, 'demo.swift');
  if (!existsSync(demoFile)) throw new Error(`${demoFile}: no demo yet; write one (a ${demoClass} XCTestCase with ${demoMethod}) or skip`);
  const demo = readFileSync(demoFile, 'utf8');
  if (!new RegExp(`class\\s+${demoClass}\\s*:\\s*XCTestCase`).test(demo) || !new RegExp(`func\\s+${demoMethod}\\s*\\(`).test(demo)) {
    throw new Error(`${demoFile}: needs "final class ${demoClass}: XCTestCase" with "func ${demoMethod}()", which is what gets run`);
  }
  const { text, layout } = injected(originalSource(run, config.injectInto), readFileSync(helperFile, 'utf8'), demo);
  const path = join(run.src, config.injectInto);
  const changed = !existsSync(path) || readFileSync(path, 'utf8') !== text;
  if (changed) writeFileSync(path, text);
  return { path, layout, changed };
}
