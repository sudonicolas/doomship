#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolveChange } from './change.ts';
import { ConfigError, loadConfig } from './config.ts';
import { exec } from './exec.ts';
import { checkSimulator, createSimulatorArgs, formatChecks, runDoctor } from './doctor.ts';
import { fontsDir } from './fonts.ts';
import { prepare } from './prepare.ts';

const usage = `Usage: doomship <command> [options]

Commands:
  doctor                    Check the tools doomship needs. --fix creates the "doomship" simulator.
  prepare <repo> <change>   Export the change and write its run: diff.patch, changes.json, context.md.

A change is a commit, a range (a..b, or a...b from their merge-base), a branch (from where it left
main), or --worktree for uncommitted changes.

Options:
  --worktree      The change is the working tree, untracked files included.
  --config <file> The config, instead of the repo's .doomship.json.
  -h, --help      Show this help.`;

function main(argv: string[]): number {
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
    default:
      return usageError(`Unknown command: ${command}`);
  }
}

function usageError(message: string): number {
  console.error(`${message}\n\n${usage}`);
  return 64;
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

process.exitCode = main(process.argv.slice(2));
