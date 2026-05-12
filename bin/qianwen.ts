#!/usr/bin/env node
export {};

import { resetGlobalCache } from '../src/utils/cache.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  // REPL mode — dynamic import to avoid loading cost in one-shot mode
  const { startRepl } = await import('../src/repl.js');
  try {
    await startRepl();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`REPL error: ${message}\n`);
    resetGlobalCache();
    process.exitCode = 1;
  }
} else {
  // One-shot mode
  const { createProgram } = await import('../src/cli.js');
  const { CliError, HandledError } = await import('../src/utils/errors.js');
  const { flushDebugReport } = await import('../src/api/debug-buffer.js');
  const program = createProgram();

  const formatFromArgv = (): string | undefined => {
    const args = process.argv.slice(2);
    const i = args.findIndex((a) => a === '--format' || a.startsWith('--format='));
    if (i < 0) return undefined;
    const arg = args[i];
    if (arg.includes('=')) return arg.split('=', 2)[1];
    return args[i + 1];
  };

  const wantsJSON = (): boolean => formatFromArgv() === 'json';

  const quietIdx = process.argv.findIndex((a) => a === '--quiet' || a === '-q');
  if (quietIdx >= 0) {
    const noop = (..._args: unknown[]): boolean => true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = noop;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = noop;
    try {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    } catch {
      /* some runtimes mark these read-only — best-effort */
    }
    process.argv.splice(quietIdx, 1);
  }

  try {
    await program.parseAsync(process.argv);
    flushDebugReport();
    resetGlobalCache();
  } catch (err: unknown) {
    flushDebugReport();

    const e = err as { code?: string; exitCode?: number; message?: string };
    if (e && typeof e.code === 'string' && e.code.startsWith('commander.')) {
      const exitCode = typeof e.exitCode === 'number' ? e.exitCode : 1;
      if (exitCode === 0) {
        resetGlobalCache();
      } else {
        const code = mapCommanderCode(e.code);
        let message = e.message || 'Command parse error';
        if (message.startsWith('error: ')) {
          message = message.slice(7);
        }
        if (wantsJSON()) {
          process.stderr.write(
            JSON.stringify(
              {
                error: { code, message, exit_code: exitCode },
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          console.error(`Error: ${message}`);
        }
        resetGlobalCache();
        process.exitCode = exitCode;
      }
    } else if (err instanceof HandledError) {
      resetGlobalCache();
      process.exitCode = err.exitCode;
    } else if (err instanceof CliError) {
      if (wantsJSON()) {
        process.stderr.write(JSON.stringify(err.toJSON(), null, 2) + '\n');
      } else {
        console.error(`Error: ${err.message}`);
      }
      resetGlobalCache();
      process.exitCode = err.exitCode;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      if (wantsJSON()) {
        process.stderr.write(
          JSON.stringify(
            {
              error: { code: 'UNKNOWN_ERROR', message, exit_code: 1 },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        console.error(`Error: ${message}`);
      }
      resetGlobalCache();
      process.exitCode = 1;
    }
  }

  try {
    const sym1 = Symbol.for('undici.globalDispatcher.1');
    const sym0 = Symbol.for('undici.globalDispatcher');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatcher = (globalThis as any)[sym1] ?? (globalThis as any)[sym0];
    if (dispatcher && typeof dispatcher.close === 'function') {
      await dispatcher.close();
    }
  } catch {
    // Best-effort
  }
}

function mapCommanderCode(code: string): string {
  switch (code) {
    case 'commander.unknownCommand':
      return 'UNKNOWN_COMMAND';
    case 'commander.unknownOption':
      return 'UNKNOWN_OPTION';
    case 'commander.missingArgument':
      return 'MISSING_ARGUMENT';
    case 'commander.missingMandatoryOptionValue':
      return 'MISSING_OPTION';
    case 'commander.optionMissingArgument':
      return 'MISSING_OPTION_VALUE';
    case 'commander.invalidArgument':
      return 'INVALID_ARGUMENT';
    case 'commander.excessArguments':
      return 'EXCESS_ARGUMENTS';
    default:
      return 'INVALID_USAGE';
  }
}
