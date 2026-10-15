#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveChange } from './change.ts';
import { ConfigError, loadConfig } from './config.ts';
import { exec } from './exec.ts';
import { checkSimulator, createSimulatorArgs, formatChecks, runDoctor } from './doctor.ts';
import { fontsDir } from './fonts.ts';
import { iosDriver } from './drivers/ios/index.ts';
import { prepare } from './prepare.ts';
import { render } from './render/index.ts';
import { loadRun } from './run.ts';

const usage = `Usage: doomship <command> [options]

Commands:
  doctor                    Check the tools doomship needs. --fix creates the "doomship" simulator.
  prepare <repo> <change>   Export the change and write its run: diff.patch, changes.json, context.md.
  build <run>               Build the run's demo.swift; a failure is written to failure.txt.
  record <run>              Build, then record the demo: video.mov and events.json, or failure.txt.
                            Exits 0 recorded, 1 the build or the demo failed, 2 it stalled twice.
  render <run>              Render the recording as the PR GIF, with its poster and sidecar.

A change is a commit, a range (a..b, or a...b from their merge-base), a branch (from where it left
main), or --worktree for uncommitted changes.

Options:
  --worktree      The change is the working tree, untracked files included.
  --config <file> The config, instead of the repo's .doomship.json.
  --mp4           render: an MP4 of the same cut too.
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
        if (run.config.platform !== 'ios') return fail('build: only iOS for now');
        const b = await iosDriver.prepareBuild(run);
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
        if (run.config.platform !== 'ios') return fail('record: only iOS for now');
        const b = await iosDriver.prepareBuild(run);
        if (!b.ok) return fail(`${b.failure}(build ${b.seconds.toFixed(1)} s; ${tilde(run.dir)}/failure.txt)`);
        const started = Date.now();
        const r = await iosDriver.record(run);
        const seconds = (Date.now() - started) / 1000;
        writeFileSync(join(run.dir, 'record.json'), JSON.stringify({ buildSeconds: b.seconds, recordSeconds: seconds, failed: Boolean(r.failure), stalled: Boolean(r.stalled) }, null, 2) + '\n');
        if (r.failure) {
          console.error(`${r.failure}(build ${b.seconds.toFixed(1)} s, record ${seconds.toFixed(1)} s; ${tilde(run.dir)}/failure.txt)`);
          return r.stalled ? 2 : 1;
        }
        console.log(`Recorded ${run.change.id}: build ${b.seconds.toFixed(1)} s, record ${seconds.toFixed(1)} s\n  ${tilde(r.video)}\n  ${tilde(r.events)}`);
        return 0;
      } catch (e) {
        return fail(`record: ${(e as Error).message}`);
      }
    }
    case 'render': {
      if (rest.length !== 1) return usageError('render needs one run directory');
      try {
        const g = render(loadRun(rest[0]), { mp4: values.mp4 });
        console.log([
          `Rendered in ${g.seconds.toFixed(1)} s: ${g.duration.toFixed(1)} s, ${(g.bytes / 1048576).toFixed(1)} MB, ${g.width}×${g.height} at ${g.fps} fps`,
          `  ${tilde(g.gif)}`, `  ${tilde(g.png)}`, `  ${tilde(g.json)}`, ...(g.mp4 ? [`  ${tilde(g.mp4)}`] : []),
        ].join('\n'));
        return 0;
      } catch (e) {
        return fail(`render: ${(e as Error).message}`);
      }
    }
    default:
      return usageError(`Unknown command: ${command}`);
  }
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

function usageError(message: string): number {
  console.error(`${message}\n\n${usage}`);
  return 64;
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

main(process.argv.slice(2)).then((code) => (process.exitCode = code));
