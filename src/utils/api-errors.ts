/**
 * HTTP error classifier — transforms raw network/HTTP errors into structured
 * CliError instances with user-friendly messages (graceful mode) and full
 * diagnostic details (verbose mode).
 */
import { CliError } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';
import { loginCommand } from './runtime-mode.js';

/**
 * Classify a raw HTTP/network error into a structured CliError.
 *
 * The returned CliError carries:
 * - `message`: user-friendly summary (shown in graceful mode)
 * - `detail`: full diagnostic string including URL, status, response body
 *   (shown in verbose mode; omitted in graceful mode)
 */
export function classifyHttpError(error: unknown, url?: string): CliError {
  // Already a CliError — return as-is (may add detail if missing)
  if (error instanceof CliError) {
    return error;
  }

  // ---- Network-level failures (fetch threw before receiving a response) ----
  if (error instanceof Error) {
    const name = error.name;
    const msg = error.message;
    const causeText = readCauseText(error);
    const netHaystack = `${msg} ${causeText}`;

    // Gateway business / envelope errors carry a server-provided message that
    // explains *why* the request was rejected (e.g. a ticket-creation policy
    // failure on an app-scoped category). Surface that message directly instead
    // of masking it behind a generic "unexpected error" — it is the real,
    // user-actionable reason and the primary signal for diagnosing API failures.
    if (name === 'GatewayBusinessError' || name === 'GatewayEnvelopeError') {
      const rawCode = (error as { code?: unknown }).code;
      const codeStr = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : undefined;
      return new CliError({
        code: 'API_ERROR',
        message: msg || 'API request failed.',
        exitCode: EXIT_CODES.GENERAL_ERROR,
        detail: buildDetail(codeStr ? `[${codeStr}] ${msg}` : msg, url, error),
      });
    }

    // Timeout (AbortError from our 30s controller)
    if (name === 'AbortError') {
      return new CliError({
        code: 'NETWORK_ERROR',
        message: 'Request timed out. Try again later.',
        exitCode: EXIT_CODES.NETWORK_ERROR,
        detail: buildDetail('Request timed out after 30s', url, error),
      });
    }

    // DNS / connection refused / network unreachable
    if (
      netHaystack.includes('ECONNREFUSED') ||
      netHaystack.includes('ENOTFOUND') ||
      netHaystack.includes('ENETUNREACH') ||
      netHaystack.includes('EAI_AGAIN') ||
      netHaystack.includes('ECONNRESET') ||
      netHaystack.includes('EPIPE') ||
      msg === 'terminated' ||
      netHaystack.includes('other side closed') ||
      msg.includes('fetch failed') ||
      name === 'ConnectionClosedError'
    ) {
      return new CliError({
        code: 'NETWORK_ERROR',
        message: 'API unreachable. Check your network connection.',
        exitCode: EXIT_CODES.NETWORK_ERROR,
        detail: buildDetail(msg, url, error),
      });
    }

    // HTTP status errors — parse status from message like "HTTP 403: Forbidden"
    const httpMatch = msg.match(/^HTTP (\d+):\s*(.*)/);
    if (httpMatch) {
      const status = parseInt(httpMatch[1], 10);
      const statusText = httpMatch[2];
      return classifyByHttpStatus(status, statusText, url, error);
    }

    // Generic network failure with cause chain
    if (msg.startsWith('Network request failed')) {
      return new CliError({
        code: 'NETWORK_ERROR',
        message: 'Network error. Check your connection and try again.',
        exitCode: EXIT_CODES.NETWORK_ERROR,
        detail: buildDetail(msg, url, error),
      });
    }

    // Auth-related message from getAuthHeaders()
    if (msg.includes('Not authenticated')) {
      return new CliError({
        code: 'AUTH_REQUIRED',
        message: `Not authenticated. Run: ${loginCommand()}`,
        exitCode: EXIT_CODES.AUTH_FAILURE,
        detail: buildDetail(msg, url, error),
      });
    }

    // API error from listModels etc: "API error: ..."
    if (msg.startsWith('API error:')) {
      return new CliError({
        code: 'API_ERROR',
        message: 'API request failed. Try again later.',
        exitCode: EXIT_CODES.GENERAL_ERROR,
        detail: buildDetail(msg, url, error),
      });
    }

    // Local filesystem failures (e.g. writing an artifact via --out). These
    // carry a POSIX `code`; surface an actionable message instead of masking
    // the real cause behind a generic "unexpected error".
    const fsError = classifyFsError(error, msg);
    if (fsError) return fsError;

    // Fallback: any other Error
    return new CliError({
      code: 'UNKNOWN_ERROR',
      message: 'An unexpected error occurred.',
      exitCode: EXIT_CODES.GENERAL_ERROR,
      detail: buildDetail(msg, url, error),
    });
  }

  // Non-Error thrown
  const str = String(error);
  return new CliError({
    code: 'UNKNOWN_ERROR',
    message: 'An unexpected error occurred.',
    exitCode: EXIT_CODES.GENERAL_ERROR,
    detail: str || undefined,
  });
}

/** Read the code/message of a nested `error.cause` (undici surfaces the real network reason there). */
function readCauseText(error: Error): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return `${typeof code === 'string' ? code : ''} ${cause.message}`;
  }
  if (typeof cause === 'string') return cause;
  return '';
}

/**
 * Map a POSIX filesystem error `code` (e.g. writing an artifact via --out) to
 * an actionable message. Returns undefined for non-filesystem errors.
 */
export function friendlyFsMessage(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  const fsCodes: Record<string, string> = {
    EACCES: 'Permission denied writing the output file.',
    EPERM: 'Operation not permitted writing the output file.',
    ENOENT: 'Cannot write the output file: a parent directory does not exist or is not writable.',
    EEXIST: 'Output path already exists and cannot be replaced.',
    EROFS: 'Cannot write the output file: read-only filesystem.',
    ENOSPC: 'Cannot write the output file: no space left on device.',
    EISDIR: 'Output path is a directory, not a file.',
    ENOTDIR: 'A path component of the output is not a directory.',
    ENAMETOOLONG: 'Output file name is too long.',
    EMFILE: 'Too many open files; close some and retry.',
    ENFILE: 'System file-table is full; retry later.',
  };
  return typeof code === 'string' ? fsCodes[code] : undefined;
}

/**
 * Classify a local filesystem error (POSIX `code`) into a CliError with an
 * actionable message. Returns undefined for non-filesystem errors.
 */
function classifyFsError(error: Error, msg: string): CliError | undefined {
  const friendly = friendlyFsMessage(error);
  if (!friendly) return undefined;
  return new CliError({
    code: 'IO_ERROR',
    message: friendly,
    exitCode: EXIT_CODES.GENERAL_ERROR,
    detail: buildDetail(msg, undefined, error),
  });
}

/**
 * Classify by HTTP status code.
 */
/**
 * Derive the detail message for HTTP status classification.
 * Uses the original error's full message (which includes URL + response body)
 * rather than reconstructing from just the status line.
 */
function httpDetail(status: number, statusText: string, url?: string, error?: Error): string {
  // When the error message starts with "HTTP <status>:", it was constructed
  // by base-client.ts and contains the full diagnostic (URL + response body).
  // Use it directly to preserve all detail.
  if (error?.message && /^HTTP \d+:/.test(error.message)) {
    return buildDetail(error.message, url, error);
  }
  return buildDetail(`HTTP ${status}: ${statusText}`, url, error);
}

function classifyByHttpStatus(
  status: number,
  statusText: string,
  url?: string,
  error?: Error,
): CliError {
  if (status === 401) {
    return new CliError({
      code: 'AUTH_REQUIRED',
      message: `Not authenticated. Run: ${loginCommand()}`,
      exitCode: EXIT_CODES.AUTH_FAILURE,
      detail: httpDetail(401, statusText, url, error),
    });
  }

  if (status === 403) {
    return new CliError({
      code: 'TOKEN_EXPIRED',
      message: `Token expired. Run: ${loginCommand()}`,
      exitCode: EXIT_CODES.AUTH_FAILURE,
      detail: httpDetail(403, statusText, url, error),
    });
  }

  if (status === 404) {
    return new CliError({
      code: 'NOT_FOUND',
      message: 'Resource not found.',
      exitCode: EXIT_CODES.NOT_FOUND,
      detail: httpDetail(404, statusText, url, error),
    });
  }

  if (status === 429) {
    return new CliError({
      code: 'RATE_LIMITED',
      message: 'Too many requests. Wait and retry.',
      exitCode: EXIT_CODES.RATE_LIMITED,
      detail: httpDetail(429, statusText, url, error),
    });
  }

  if (status >= 500) {
    return new CliError({
      code: 'SERVER_ERROR',
      message: 'Server error. Try again later.',
      exitCode: EXIT_CODES.SERVER_ERROR,
      detail: httpDetail(status, statusText, url, error),
    });
  }

  return new CliError({
    code: 'API_ERROR',
    message: 'API request failed.',
    exitCode: EXIT_CODES.GENERAL_ERROR,
    detail: httpDetail(status, statusText, url, error),
  });
}

/**
 * Build a verbose detail string from error info.
 * Includes the raw message, URL, and cause chain.
 */
function buildDetail(message: string, url?: string, error?: Error): string {
  const parts: string[] = [message];
  if (url) parts.push(`  URL: ${url}`);
  // Append cause chain
  if (error?.cause) {
    let current: unknown = error.cause;
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
  }
  return parts.join('\n');
}
