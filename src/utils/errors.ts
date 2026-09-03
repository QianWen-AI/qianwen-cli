import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { flushDebugReport } from '../api/debug-buffer.js';
import { loginCommand } from './runtime-mode.js';
import { resetGlobalCache } from './cache.js';
import { classifyHttpError } from './api-errors.js';
import { clearSpinnerLine } from '../ui/spinner.js';
import { redactPaymentData } from './strings.js';
import { theme } from '../ui/theme.js';

// Re-export from leaf module (avoids circular deps with debug-buffer.ts)
export { getErrorVerbosity, type ErrorVerbosity } from './verbosity.js';
import { getErrorVerbosity } from './verbosity.js';

/**
 * Format an error headline for stderr. On a TTY it gains a red ✗ icon and a
 * bold-red message; piped/non-TTY output stays the plain `Error: <message>`
 * string so scripts and tests keep a stable contract.
 */
function errorLine(message: string): string {
  if (!process.stderr.isTTY) return `Error: ${message}`;
  return `${theme.errorForced(theme.symbols.fail)} ${theme.errorForced.bold(message)}`;
}

/** Format an actionable hint line: dim, with a subtle arrow, only on a TTY. */
function hintLine(hint: string): string {
  if (!process.stderr.isTTY) return `  ${hint}`;
  return `  ${theme.dim(theme.symbols.arrow)} ${theme.dim(hint)}`;
}

export interface CliErrorOptions {
  code: string; // e.g., 'AUTH_REQUIRED', 'MODEL_NOT_FOUND'
  message: string; // Human-readable message (shown in graceful mode)
  exitCode: ExitCode;
  detail?: string; // Full diagnostic info (shown in verbose mode)
  model?: string; // Model the failed request targeted, when known
  hint?: string; // Actionable next step (e.g. how to inspect supported fields)
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly detail?: string;
  readonly model?: string;
  readonly hint?: string;

  constructor(options: CliErrorOptions) {
    super(options.message);
    this.name = 'CliError';
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.detail = options.detail;
    this.model = options.model;
    this.hint = options.hint;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: redactErrorText(this.message, this),
        ...(this.model ? { model: this.model } : {}),
        ...(this.hint ? { hint: redactErrorText(this.hint, this) } : {}),
        exit_code: this.exitCode,
        ...(this.detail ? { detail: redactErrorText(this.detail, this) } : {}),
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

export function ticketNotFoundError(ticketId: string): CliError {
  return new CliError({
    code: 'NOT_FOUND',
    message: `Ticket not found: ${ticketId}`,
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
      parts.push(`  Caused by: ${redactErrorText(current.message, err)}`);
      current = current.cause;
    } else {
      parts.push(`  Caused by: ${redactErrorText(String(current), err)}`);
      break;
    }
    depth++;
  }
  return parts.join('\n');
}

/**
 * Redact payment data at the last boundary before user-visible error output.
 *
 * @param value Error text that may contain payment identifiers.
 * @param context Whole error/context used to discover unlabeled repeated values.
 * @returns Payment-safe error text.
 */
function redactErrorText(value: string, context?: unknown): string {
  const safe = redactPaymentData({ context, value }) as { value: string };
  return safe.value;
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

  if ((error as { code?: string })?.code === 'repl.exit.intercepted') throw error;

  // suppress: no error output at all — just propagate exit code
  if (verbosity === 'suppress') {
    resetGlobalCache();
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    throw new HandledError(exitCode);
  }

  // Plain Error carrying a numeric `.exitCode` hint — used by Service-layer
  // errors that don't import `CliError` (e.g., RunService rejections that
  // surface a contract-defined exit code without coupling to the command
  // layer's error type).
  if (
    error instanceof Error &&
    !(error instanceof CliError) &&
    typeof (error as { exitCode?: unknown }).exitCode === 'number'
  ) {
    const e = error as Error & { exitCode: number; code?: string };
    const code = typeof e.code === 'string' ? e.code : 'ERROR';
    const safeMessage = redactErrorText(e.message, e);
    if (format === 'json') {
      process.stderr.write(
        JSON.stringify({ error: { code, message: safeMessage, exit_code: e.exitCode } }, null, 2) +
          '\n',
      );
    } else {
      console.error(errorLine(safeMessage));
    }
    resetGlobalCache();
    throw new HandledError(e.exitCode);
  }

  // Classify raw errors into CliError for graceful/verbose output
  const cliError = error instanceof CliError ? error : classifyHttpError(error);

  if (verbosity === 'verbose') {
    // Verbose mode: output full diagnostic info (backward-compatible)
    if (error instanceof CliError) {
      if (format === 'json') {
        process.stderr.write(JSON.stringify(cliError.toJSON(), null, 2) + '\n');
      } else {
        const safeMessage = redactErrorText(cliError.message, cliError);
        const safeDetail = cliError.detail ? redactErrorText(cliError.detail, cliError) : undefined;
        const output = cliError.detail
          ? `${errorLine(safeMessage)}\n${process.stderr.isTTY ? theme.dim(safeDetail ?? '') : safeDetail}`
          : errorLine(safeMessage);
        console.error(output);
        if (cliError.hint) console.error(hintLine(redactErrorText(cliError.hint, cliError)));
      }
    } else {
      // Non-CliError: preserve legacy verbose output with cause chain
      const message = redactErrorText(
        error instanceof Error ? error.message : String(error),
        error,
      );
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
        console.error(errorLine(fullMessage));
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
          error: {
            code: cliError.code,
            message: redactErrorText(cliError.message, { error, cliError }),
            ...(cliError.model ? { model: cliError.model } : {}),
            ...(cliError.hint ? { hint: redactErrorText(cliError.hint, { error, cliError }) } : {}),
            exit_code: cliError.exitCode,
          },
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    console.error(errorLine(redactErrorText(cliError.message, { error, cliError })));
    if (cliError.hint) {
      console.error(hintLine(redactErrorText(cliError.hint, { error, cliError })));
    }
  }
  resetGlobalCache();
  throw new HandledError(cliError.exitCode);
}
