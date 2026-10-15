#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { resolveChange } from './change.ts';
import { ConfigError, loadConfig } from './config.ts';
import { exec } from './exec.ts';
import { checkSimulator, createSimulatorArgs, formatChecks, runDoctor } from './doctor.ts';
import { fontsDir } from './fonts.ts';
import { attemptsOf, demoName, driverFor, recordRun, skipRun, summary } from './pipeline.ts';
import { post, type Gh } from './post.ts';
import { prepare } from './prepare.ts';
import { render } from './render/index.ts';
import { loadRun } from './run.ts';

const usage = `Usage: doomship <command> [options]

Commands:
  doctor                    Check the tools doomship needs. --fix creates the "doomship" simulator.
  prepare <repo> <change>   Export the change and write its run: diff.patch, changes.json, context.md.
  build <run>               Build the run's demo (demo.swift, or demo.ts for web); a failure goes to failure.txt.
  record <run>              Build, then record the demo: video.mov and events.json, or failure.txt.
                            Exits 0 recorded, 1 the build or the demo failed, 2 it stalled twice.
  render <run>              Render the recording as the PR GIF, with its poster and sidecar.
  run <repo> <change>       Prepare; then, if the run has a demo, record and render it.
  skip <run> --reason "…"   Mark the change as having nothing to show (skip.json).
  post <repo> <pr>          Put the newest GIF of the PR's head in its description, through gh.
                            --dry-run prints the section and uploads nothing.

A change is a commit, a range (a..b, or a...b from their merge-base), a branch (from where it left
main), or --worktree for uncommitted changes.

Options:
  --worktree      The change is the working tree, untracked files included.
  --config <file> The config, instead of the repo's .doomship.json.
  --mp4           render, run: an MP4 of the same cut too.
  --no-splash     render, run: no doomship splash at the start and end.
  --reason <text> skip: why nothing shows.
  --dry-run       post: print what would change, change nothing.
  --viewport <v>  record, run (web): phone (390x844, the default) or desktop (1280x720).
  -h, --help      Show this help.`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        fix: { type: 'boolean' },
        worktree: { type: 'boolean' },
        config: { type: 'string' },
        mp4: { type: 'boolean' },
        'no-splash': { type: 'boolean' },
        reason: { type: 'string' },
        'dry-run': { type: 'boolean' },
        viewport: { type: 'string' },
      },
    });
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${usage}`);
    return 64;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    console.log(usage);
    return command || values.help ? 0 : 64;
  }

  switch (command) {
    case 'doctor': {
      if (rest.length) return usageError(`doctor takes no arguments: ${rest.join(' ')}`);
      if (values.fix && !checkSimulator(exec).ok) {
        console.log(`Creating the simulator: xcrun ${createSimulatorArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
        const r = exec('xcrun', createSimulatorArgs);
        if (!r.ok) console.error(r.stderr.trim());
      }
      const checks = runDoctor(exec, process.env, fontsDir);
      console.log(formatChecks(checks));
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    case 'prepare': {
      const [repo, spec, ...extra] = rest;
      if (!repo) return usageError('prepare needs a repo and a change');
      if (extra.length) return usageError(`prepare takes a repo and one change, not: ${extra.join(' ')}`);
      if (!spec === !values.worktree) return usageError('prepare needs a change, or --worktree (not both)');
      try {
        const config = loadConfig(repo, values.config);
        const p = prepare(repo, resolveChange(repo, spec), config);
        const ui = p.uiFiles.length;
        console.log([
          `Prepared ${p.change.id}: ${p.change.title}`,
          `  run:      ${tilde(p.run)}`,
          `  files:    ${p.files.length} changed, ${ui} ui${ui ? '' : ' (nothing a user sees may have changed)'}`,
          `  context:  ${(p.contextBytes / 1024).toFixed(1)} KB${p.cut.length ? `, cut to fit: ${p.cut.join(', ')}` : ''}`,
        ].join('\n'));
        return 0;
      } catch (e) {
        console.error(e instanceof ConfigError ? e.message : `prepare: ${(e as Error).message}`);
        return 1;
      }
    }
    case 'build': {
      if (rest.length !== 1) return usageError('build needs one run directory');
      try {
        const run = loadRun(rest[0]);
        const b = await driverFor(run).prepareBuild(run);
        if (b.ok) console.log(`Built ${run.change.id} in ${b.seconds.toFixed(1)} s`);
        else console.error(`${b.failure}(${b.seconds.toFixed(1)} s; ${tilde(run.dir)}/failure.txt)`);
        return b.ok ? 0 : 1;
      } catch (e) {
        return fail(`build: ${(e as Error).message}`);
      }
    }
    case 'record': {
      if (rest.length !== 1) return usageError('record needs one run directory');
      try {
        const run = loadRun(rest[0]);
        const a = await recordRun(run, { viewport: viewportOf(values.viewport) });
        const times = `build ${a.buildSeconds.toFixed(1)} s${a.recordSeconds !== undefined ? `, record ${a.recordSeconds.toFixed(1)} s` : ''}`;
        if (a.failure) {
          console.error(`${a.failure}(${times}; ${tilde(run.dir)}/failure.txt)`);
          return a.outcome === 'stalled' ? 2 : 1;
        }
        console.log(`Recorded ${run.change.id}: ${times}\n  ${tilde(join(run.dir, 'video.mov'))}\n  ${tilde(join(run.dir, 'events.json'))}`);
        return 0;
      } catch (e) {
        return fail(`record: ${(e as Error).message}`);
      }
    }
    case 'render': {
      if (rest.length !== 1) return usageError('render needs one run directory');
      try {
        const g = render(loadRun(rest[0]), { mp4: values.mp4, splash: !values['no-splash'] });
        console.log([
          `Rendered in ${g.seconds.toFixed(1)} s: ${g.duration.toFixed(1)} s, ${(g.bytes / 1048576).toFixed(1)} MB, ${g.width}×${g.height} at ${g.fps} fps`,
          `  ${tilde(g.gif)}`, `  ${tilde(g.png)}`, `  ${tilde(g.json)}`, ...(g.mp4 ? [`  ${tilde(g.mp4)}`] : []),
        ].join('\n'));
        return 0;
      } catch (e) {
        return fail(`render: ${(e as Error).message}`);
      }
    }
    case 'run': {
      const [repo, spec, ...extra] = rest;
      if (!repo) return usageError('run needs a repo and a change');
      if (extra.length) return usageError(`run takes a repo and one change, not: ${extra.join(' ')}`);
      if (!spec === !values.worktree) return usageError('run needs a change, or --worktree (not both)');
      try {
        const p = prepare(repo, resolveChange(repo, spec), loadConfig(repo, values.config));
        const run = loadRun(p.run);
        if (existsSync(join(run.dir, 'skip.json'))) {
          console.log(`Skipped ${run.change.id}: ${JSON.parse(readFileSync(join(run.dir, 'skip.json'), 'utf8')).reason}`);
          return 0;
        }
        if (!existsSync(join(run.dir, demoName(run)))) {
          console.log(`Prepared ${run.change.id}: ${run.change.title}\n  ${tilde(run.dir)}/context.md\n` +
            `No demo yet: write ${demoName(run)} there and run again, or: doomship skip ${tilde(run.dir)} --reason "…"`);
          return 0;
        }
        const a = await recordRun(run, { viewport: viewportOf(values.viewport) });
        if (a.failure) {
          console.error(`${a.failure}(attempt ${attemptsOf(run).length}; ${tilde(run.dir)}/failure.txt)`);
          return a.outcome === 'stalled' ? 2 : 1;
        }
        const g = render(run, { mp4: values.mp4, splash: !values['no-splash'] });
        console.log(summary(run, attemptsOf(run), g, tilde));
        return 0;
      } catch (e) {
        return fail(e instanceof ConfigError ? e.message : `run: ${(e as Error).message}`);
      }
    }
    case 'skip': {
      if (rest.length !== 1) return usageError('skip needs one run directory');
      if (!values.reason) return usageError('skip needs --reason "…": what the change does and why nothing shows');
      try {
        const run = loadRun(rest[0]);
        skipRun(run, values.reason);
        console.log(`Skipped ${run.change.id}: ${values.reason.trim()}`);
        return 0;
      } catch (e) {
        return fail(`skip: ${(e as Error).message}`);
      }
    }
    case 'post': {
      const [repo, pr, ...extra] = rest;
      if (!repo || !pr || extra.length) return usageError('post needs a repo and a PR number');
      try {
        const dryRun = Boolean(values['dry-run']);
        const p = post(gh, repo, basename(resolve(repo)), pr, { dryRun });
        if (dryRun) {
          console.log(`Would put ${tilde(p.render.gif)} in ${p.pr.url}, hosted in ${p.pr.headRepo.owner}/${p.pr.headRepo.name}:\n\n${p.section}`);
        } else {
          console.log(`Posted to ${p.pr.url}\n  ${p.url}`);
        }
        return 0;
      } catch (e) {
        return fail(`post: ${(e as Error).message}`);
      }
    }
    default:
      return usageError(`Unknown command: ${command}`);
  }
}

function viewportOf(v: string | undefined): 'phone' | 'desktop' | undefined {
  if (v === undefined || v === 'phone' || v === 'desktop') return v;
  throw new Error(`--viewport is phone or desktop, not ${v}`);
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

function usageError(message: string): number {
  console.error(`${message}\n\n${usage}`);
  return 64;
}

/** gh, run from doomship's own folder (never the demoed repo's), with stdin when given. */
const gh: Gh = (args, input) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, stdout: '', stderr: 'gh is not installed: brew install gh, then gh auth login' };
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

main(process.argv.slice(2)).then((code) => (process.exitCode = code));
