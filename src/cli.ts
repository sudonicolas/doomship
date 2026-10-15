#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { exec } from './exec.ts';
import { checkSimulator, createSimulatorArgs, formatChecks, runDoctor } from './doctor.ts';
import { fontsDir } from './fonts.ts';

const usage = `Usage: doomship <command> [options]

Commands:
  doctor          Check the tools doomship needs. --fix creates the "doomship" simulator.

Options:
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
    default:
      return usageError(`Unknown command: ${command}`);
  }
}

function usageError(message: string): number {
  console.error(`${message}\n\n${usage}`);
  return 64;
}

process.exitCode = main(process.argv.slice(2));
