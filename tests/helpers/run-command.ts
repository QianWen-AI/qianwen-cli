/**
 * Run a Commander-based command in-process and capture its observable side
 * effects (stdout, stderr, exit code) so tests can assert on them.
 *
 * Why not just call the action function directly? Because the action reads
 * `--format` from the command's parent chain via `resolveFormatFromCommand`,
 * and parses options through Commander. Running the real Commander pipeline
 * keeps the test honest about how a user would actually invoke the command.
 *
 * Usage:
 *
 *   const result = await runCommand(
 *     (program) => {
 *       const u = program.command('usage').command('breakdown')
 *         .requiredOption('--model <id>')
 *         .option('--granularity <g>');
 *       u.action(usageBreakdownAction(u));
 *     },
 *     ['usage', 'breakdown', '--model', 'qwen3-ma', '--format', 'json'],
 *   );
 *   expect(result.exitCode).toBe(1);
 *   expect(JSON.parse(result.stdout).error.code).toBe('MODEL_NOT_FOUND');
 */
import { Command } from 'commander';
import { vi } from 'vitest';
import { HandledError } from '../../src/utils/errors.js';
import { site } from '../../src/site.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

/** Sentinel used to unwind out of an action when `process.exit` is called. */
class ProcessExitSentinel extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

export async function runCommand(
  setup: (program: Command) => void,
  argv: string[],
): Promise<RunResult> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let exitCode: number | undefined;

  const stringify = (a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a));

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdoutLines.push(args.map(stringify).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderrLines.push(args.map(stringify).join(' '));
  });
  // handleError writes structured JSON errors directly to process.stderr — not
  // through console.error — so the Agent sees the full payload on stderr without
  // the "Error: " prefix that console.error would imply.
  const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    stderrLines.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as any);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new ProcessExitSentinel(code);
  }) as never);

  const program = new Command()
    .name(site.cliName)
    .option('--format <fmt>', 'output format')
    .exitOverride()
    .configureOutput({
      // Swallow Commander's own usage / error printing; tests assert on the
      // command's own stderr (handleError) instead.
      writeOut: () => {},
      writeErr: () => {},
    });

  setup(program);

  try {
    await program.parseAsync(['node', site.cliName, ...argv]);
  } catch (e) {
    if (e instanceof HandledError) {
      // handleError() already printed the formatted message; capture the exit code.
      exitCode = e.exitCode;
    } else if (e instanceof ProcessExitSentinel) {
      // expected — fallback for code that still calls process.exit()
    } else if ((e as { code?: string }).code === 'commander.helpDisplayed') {
      // expected — `--help` triggered
    } else {
      throw e;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    stdout: stdoutLines.join('\n'),
    stderr: stderrLines.join('\n'),
    exitCode,
  };
}
