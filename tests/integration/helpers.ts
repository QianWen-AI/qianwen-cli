/**
 * Integration test helpers — stdout/stderr capture and command runner.
 *
 * Design decisions:
 * - Intercept `console.log` because CLI output functions (outputJSON, outputText,
 *   handleError) all use console.log internally. Vitest intercepts
 *   process.stdout.write, so console.log interception is the reliable path.
 * - Intercept `console.error` for error output (handleError uses console.error
 *   for non-JSON formats).
 * - Catch `HandledError` thrown by handleError() to capture exit codes.
 *   handleError() no longer calls process.exit(); it throws HandledError instead.
 * - Keep `process.exit` interception as a fallback for Commander's own exit calls.
 * - Return a structured `CommandResult` with stdout, stderr, and exitCode.
 */
import { createProgram } from '../../src/cli.js';
import { HandledError } from '../../src/utils/errors.js';

/** Structured result from running a CLI command. */
export interface CommandResult {
  /** Captured stdout (console.log + process.stdout.write) */
  stdout: string;
  /** Captured stderr (console.error) */
  stderr: string;
  /** Exit code (0 if command completed normally, or the code passed to process.exit) */
  exitCode: number;
}

/**
 * Run a CLI command and return structured output + exit code.
 *
 * Intercepts console.log, console.error, process.stdout.write, and
 * process.exit to capture the full command lifecycle without side effects.
 *
 * @param args - CLI arguments (without 'node' and 'qianwen' prefix)
 */
export async function runCommand(args: string[]): Promise<CommandResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 0;

  // Save originals
  const origLog = console.log;
  const origError = console.error;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;

  // Intercept console.log → stdout
  console.log = (...args: any[]) => {
    stdoutChunks.push(args.map(String).join(' ') + '\n');
  };

  // Intercept console.error → stderr
  console.error = (...args: any[]) => {
    stderrChunks.push(args.map(String).join(' ') + '\n');
  };

  // Intercept process.stdout.write → stdout (for direct writes)
  process.stdout.write = ((chunk: any) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  // Intercept process.stderr.write → stderr (Commander error output)
  process.stderr.write = ((chunk: any) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  // Intercept process.exit → capture exit code
  (process as any).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code ?? 0 });
  };

  try {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'qianwen', ...args]);
  } catch (err: unknown) {
    if (err instanceof HandledError) {
      // handleError() already printed the formatted message; just capture the
      // exit code it chose.
      exitCode = err.exitCode;
    }
    // Commander exitOverride / process.exit mock throws — swallow it.
    // Output and exit code have already been captured.
  } finally {
    console.log = origLog;
    console.error = origError;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
}

/**
 * Run a CLI command and parse the JSON output from stdout (success path).
 * For error JSON (which is written to stderr) use `runCommandJSONErr`.
 */
export async function runCommandJSON(args: string[]): Promise<{ data: unknown; exitCode: number }> {
  const result = await runCommand(args);
  const output = result.stdout;
  // Extract JSON from output (skip any non-JSON lines like spinner output)
  const jsonMatch = output.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in stdout:\n${output}\nstderr: ${result.stderr}`);
  }
  return { data: JSON.parse(jsonMatch[1]), exitCode: result.exitCode };
}

/**
 * Run a CLI command and parse the JSON error from stderr (error path).
 * Errors must go to stderr so that Agent pipelines (`cmd | jq`) don't see
 * error JSON polluting the data stream.
 */
export async function runCommandJSONErr(args: string[]): Promise<{ data: unknown; exitCode: number }> {
  const result = await runCommand(args);
  const output = result.stderr;
  const jsonMatch = output.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in stderr:\n${output}\nstdout: ${result.stdout}`);
  }
  return { data: JSON.parse(jsonMatch[1]), exitCode: result.exitCode };
}
