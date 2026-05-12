import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { flushDebugReport } from '../api/debug-buffer.js';
import { loginCommand } from './runtime-mode.js';
import { resetGlobalCache } from './cache.js';
import { classifyHttpError } from './api-errors.js';
import { clearSpinnerLine } from '../ui/spinner.js';

// Re-export from leaf module (avoids circular deps with debug-buffer.ts)
export { getErrorVerbosity, type ErrorVerbosity } from './verbosity.js';
import { getErrorVerbosity } from './verbosity.js';

export interface CliErrorOptions {
  code: string; // e.g., 'AUTH_REQUIRED', 'MODEL_NOT_FOUND'
  message: string; // Human-readable message (shown in graceful mode)
  exitCode: ExitCode;
  detail?: string; // Full diagnostic info (shown in verbose mode)
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly detail?: string;

  constructor(options: CliErrorOptions) {
    super(options.message);
    this.name = 'CliError';
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.detail = options.detail;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        exit_code: this.exitCode,
        ...(this.detail ? { detail: this.detail } : {}),
      },
    };
  }
}

/**
 * Thrown by handleError() after it has already formatted and printed the error
 * message.  bin/qianwen.ts catches this to set process.exitCode without
 * duplicating the output.
 */
export class HandledError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super('');
    this.name = 'HandledError';
    this.exitCode = exitCode;
  }
}

// Pre-defined error factories
export function authRequiredError(): CliError {
  return new CliError({
    code: 'AUTH_REQUIRED',
    message: `Not authenticated. Run: ${loginCommand()}`,
    exitCode: EXIT_CODES.AUTH_FAILURE,
  });
}

export function tokenExpiredError(): CliError {
  return new CliError({
    code: 'TOKEN_EXPIRED',
    message: `Token expired. Run: ${loginCommand()}`,
    exitCode: EXIT_CODES.AUTH_FAILURE,
  });
}

export function modelNotFoundError(id: string): CliError {
  return new CliError({
    code: 'MODEL_NOT_FOUND',
    message: `Model '${id}' not found.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

export function networkError(detail?: string): CliError {
  return new CliError({
    code: 'NETWORK_ERROR',
    message: detail || 'Network error: API unreachable',
    exitCode: EXIT_CODES.NETWORK_ERROR,
  });
}

export function configError(detail: string): CliError {
  return new CliError({
    code: 'CONFIG_ERROR',
    message: detail,
    exitCode: EXIT_CODES.CONFIG_ERROR,
  });
}

export function invalidArgError(message: string): CliError {
  return new CliError({
    code: 'INVALID_ARGUMENT',
    message,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

export function invalidDateRangeError(from: string, to: string): CliError {
  return new CliError({
    code: 'INVALID_RANGE',
    message: `Invalid date range: from (${from}) is after to (${to})`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

/**
 * Extract the full error cause chain as a readable string.
 */
function formatErrorCauseChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err instanceof Error ? err.cause : undefined;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error) {
      parts.push(`  Caused by: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(`  Caused by: ${String(current)}`);
      break;
    }
    depth++;
  }
  return parts.join('\n');
}

// Global error handler for commands.
// Formats and outputs the error, then throws HandledError so the entry point
// can set process.exitCode without calling process.exit() (avoids the Windows
// libuv UV_HANDLE_CLOSING assertion).
//
// Verbosity levels:
//   suppress — no output, just exit code
//   graceful — user-friendly message, no internal details (default)
//   verbose  — full diagnostic info (URLs, response bodies, cause chain)
export function handleError(error: unknown, format: 'json' | 'table' | 'text'): never {
  const verbosity = getErrorVerbosity();
  clearSpinnerLine();
  flushDebugReport();

  // suppress: no error output at all — just propagate exit code
  if (verbosity === 'suppress') {
    resetGlobalCache();
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    throw new HandledError(exitCode);
  }

  // Classify raw errors into CliError for graceful/verbose output
  const cliError = error instanceof CliError ? error : classifyHttpError(error);

  if (verbosity === 'verbose') {
    // Verbose mode: output full diagnostic info (backward-compatible)
    if (error instanceof CliError) {
      if (format === 'json') {
        process.stderr.write(JSON.stringify(cliError.toJSON(), null, 2) + '\n');
      } else {
        const output = cliError.detail
          ? `Error: ${cliError.message}\n${cliError.detail}`
          : `Error: ${cliError.message}`;
        console.error(output);
      }
    } else {
      // Non-CliError: preserve legacy verbose output with cause chain
      const message = error instanceof Error ? error.message : String(error);
      const causeChain = error instanceof Error ? formatErrorCauseChain(error) : '';
      const fullMessage = causeChain ? `${message}\n${causeChain}` : message;
      if (format === 'json') {
        process.stderr.write(
          JSON.stringify(
            { error: { code: cliError.code, message: fullMessage, exit_code: cliError.exitCode } },
            null,
            2,
          ) + '\n',
        );
      } else {
        console.error(`Error: ${fullMessage}`);
      }
    }
    resetGlobalCache();
    throw new HandledError(cliError.exitCode);
  }

  // graceful (default): output user-friendly message only, hide internal details
  if (format === 'json') {
    process.stderr.write(
      JSON.stringify(
        {
          error: { code: cliError.code, message: cliError.message, exit_code: cliError.exitCode },
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    console.error(`Error: ${cliError.message}`);
  }
  resetGlobalCache();
  throw new HandledError(cliError.exitCode);
}
