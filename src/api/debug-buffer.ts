/**
 * HTTP debug buffer — collects all HTTP debug info during execution,
 * then flushes a structured report to stderr after functional output completes.
 *
 * Enabled via DEBUG_HTTP=1 environment variable.
 *
 * NOTE: production builds permanently disable this report (see `enabled` below).
 * The report contains request/response bodies that are not fully redacted, so
 * shipping it to end users would leak business data. Local development builds
 * keep the env-var gate for troubleshooting.
 */

import { getErrorVerbosity } from '../utils/verbosity.js';
import { clearSpinnerLine } from '../ui/spinner.js';

// Injected by tsup at build time via `define` (see tsup.config.ts).
// Falls back to 'development' when running under ts-node/vitest where the
// define replacement has not been applied — this preserves test behavior.
declare const __NODE_ENV__: 'production' | 'development';

/** One entry per HTTP request/response pair */
export interface HttpDebugEntry {
  /** Unique sequential ID for this call */
  id: number;
  /** Request method (GET, POST, etc.) */
  method: string;
  /** Full URL */
  url: string;
  /** Merged request headers (including auth) */
  requestHeaders: Record<string, unknown>;
  /** Request body (truncated to 2000 chars) */
  requestBody: string | null;
  /** API identity: product+action extracted from request body (e.g. "AliyunDeliveryService/ListModelSeries") */
  apiAction: string | null;
  /** Response HTTP status code (e.g. 200) — null if network-level failure */
  responseStatus: number | null;
  /** Response status text (e.g. "OK") */
  responseStatusText: string | null;
  /** Response body (truncated to 2000 chars) */
  responseBody: string | null;
  /** Timestamp when request was initiated (Date.now()) */
  startTime: number;
  /** Timestamp when response was received (Date.now()) */
  endTime: number | null;
  /** Elapsed duration in ms (endTime - startTime) */
  durationMs: number | null;
  /** Whether this request resulted in an error */
  isError: boolean;
  /** Context label (e.g. "api", "modelMapping", "freeTierQuotas", "auth", "logout") */
  context: string;
}

/**
 * Extract product+action from a request body string.
 * Handles both JSON (`{"product":"X","action":"Y",...}`) and form-urlencoded (`product=X&action=Y`) formats.
 * Returns a string like "AliyunDeliveryService/ListModelSeries", or null if neither field is found.
 */
function extractApiAction(body: string | null): string | null {
  if (!body) return null;

  // Try JSON first
  try {
    const obj = JSON.parse(body);
    const product = typeof obj.product === 'string' ? obj.product : '';
    const action = typeof obj.action === 'string' ? obj.action : '';
    if (product && action) return `${product}/${action}`;
    if (action) return action;
    if (product) return product;
    return null;
  } catch {
    // Not JSON — try form-urlencoded
  }

  // Try form-urlencoded
  try {
    const params = new URLSearchParams(body);
    const product = params.get('product') || '';
    const action = params.get('action') || '';
    if (product && action) return `${product}/${action}`;
    if (action) return action;
    if (product) return product;
    return null;
  } catch {
    return null;
  }
}

/** Diagnostic severity level */
export type DiagnosticLevel = 'debug' | 'warn';

/** Buffered diagnostic messages (the unconditional [FreeTier]/[TokenPlan]/[PAYG] logs) */
export interface DiagnosticMessage {
  /** Category tag: FreeTier, TokenPlan, PAYG */
  category: string;
  /** The message text */
  message: string;
  /** Severity level */
  level: DiagnosticLevel;
  /** Timestamp */
  timestamp: number;
}

/** The global debug buffer singleton */
interface HttpDebugBuffer {
  entries: HttpDebugEntry[];
  diagnostics: DiagnosticMessage[];
  enabled: boolean;
  nextId: number;
}

// Module-level singleton
//
// `enabled` resolves to `false` in production builds regardless of the
// DEBUG_HTTP env var, because the report includes request/response bodies
// that are not fully redacted (only the Authorization header and the auth
// endpoint response body are masked today). Letting end users toggle this
// in shipped artifacts would risk leaking business data via stderr.
//
// `__NODE_ENV__` is replaced at build time by tsup `define`, so esbuild and
// Terser can fold the left-hand operand to a constant and tree-shake the
// flush report code path out of the production bundle.
const buffer: HttpDebugBuffer = {
  entries: [],
  diagnostics: [],
  enabled:
    (typeof __NODE_ENV__ === 'undefined' || __NODE_ENV__ !== 'production') &&
    !!process.env.DEBUG_HTTP,
  nextId: 1,
};

let flushed = false;

// Safety net: flush on process.exit to catch any missed explicit flushes
if (buffer.enabled) {
  process.on('exit', () => {
    flushDebugReport();
  });
}

/** Check if debug mode is enabled */
export function isEnabled(): boolean {
  return buffer.enabled;
}

/** Start buffering a new HTTP request. Returns the entry ID. */
export function startRequest(
  method: string,
  url: string,
  headers: Record<string, unknown>,
  body: string | null,
  context: string = 'api',
): number {
  const id = buffer.nextId++;
  const rawBody = body ? body.slice(0, 2000) : null;
  buffer.entries.push({
    id,
    method,
    url,
    requestHeaders: headers,
    requestBody: rawBody,
    apiAction: extractApiAction(body),
    responseStatus: null,
    responseStatusText: null,
    responseBody: null,
    startTime: Date.now(),
    endTime: null,
    durationMs: null,
    isError: false,
    context,
  });
  return id;
}

/** End buffering for a request — fill in response info and compute duration. */
export function endRequest(
  id: number,
  status: number | null,
  statusText: string | null,
  responseBody: string | null,
  isError: boolean,
): void {
  const entry = buffer.entries.find((e) => e.id === id);
  if (!entry) return;

  entry.endTime = Date.now();
  entry.durationMs = entry.endTime - entry.startTime;
  entry.responseStatus = status;
  entry.responseStatusText = statusText;
  entry.responseBody = responseBody ? responseBody.slice(0, 2000) : null;
  entry.isError = isError;
}

/**
 * Buffer or emit a diagnostic message.
 *
 * Levels:
 *  - 'debug': internal diagnostics (heuristic results, matching details).
 *    Only shown in verbose mode; suppressed in graceful/suppress.
 *  - 'warn': degraded functionality (API failures that result in incomplete data).
 *    Shown in verbose mode (full detail) and graceful mode (user-friendly hint);
 *    suppressed only in suppress mode.
 *
 * When DEBUG_HTTP is enabled, all messages are buffered for the debug report.
 */
export function addDiagnostic(
  category: string,
  message: string,
  level: DiagnosticLevel = 'debug',
): void {
  if (buffer.enabled) {
    buffer.diagnostics.push({ category, message, level, timestamp: Date.now() });
  } else if (getErrorVerbosity() === 'verbose') {
    clearSpinnerLine();
    console.error(`[${category}] ${message}`);
  } else if (getErrorVerbosity() === 'graceful' && level === 'warn') {
    // Graceful mode: show a brief user-facing hint for degraded functionality
    clearSpinnerLine();
    console.error(`Warning: ${category} data may be incomplete.`);
  }
  // graceful+debug and suppress: silently discard
}

/** Format and print the complete debug report to stderr. */
export function flushDebugReport(): void {
  if (flushed || !buffer.enabled) return;
  flushed = true;

  if (buffer.entries.length === 0 && buffer.diagnostics.length === 0) return;

  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push('[HTTP Debug Report]');

  // Per-request detail blocks
  for (const entry of buffer.entries) {
    lines.push('');
    if (entry.apiAction) {
      lines.push(`───────── Request #${entry.id}: ${entry.apiAction} (${entry.context}) ─────────`);
    } else {
      lines.push(`───────── Request #${entry.id} (${entry.context}) ─────────`);
    }
    lines.push(`→ ${entry.method} ${entry.url}`);
    if (entry.apiAction) {
      lines.push(`→ API: ${entry.apiAction}`);
    }
    if (entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0) {
      lines.push(`→ Headers: ${JSON.stringify(entry.requestHeaders)}`);
    }
    if (entry.requestBody) {
      lines.push(`→ Body: ${entry.requestBody}`);
    }

    if (entry.responseStatus !== null) {
      const statusLine = `← ${entry.responseStatus} ${entry.responseStatusText || ''}`;
      lines.push(statusLine);
      if (entry.responseBody) {
        lines.push(`← Body: ${entry.responseBody}`);
      }
    } else {
      lines.push(`← NetworkError (no response received)`);
    }

    const duration =
      entry.durationMs !== null ? (entry.durationMs < 1 ? '<1ms' : `${entry.durationMs}ms`) : 'N/A';
    lines.push(`  Duration: ${duration}`);
    if (entry.isError) lines.push('  ✗ Failed');
  }

  // Diagnostic messages
  if (buffer.diagnostics.length > 0) {
    lines.push('');
    lines.push('─── Diagnostic Messages ───');
    for (const diag of buffer.diagnostics) {
      const levelTag = diag.level === 'warn' ? '⚠ ' : '';
      lines.push(`${levelTag}[${diag.category}] ${diag.message}`);
    }
  }

  // Summary
  lines.push('');
  lines.push('─── Summary ───');
  const total = buffer.entries.length;
  const successful = buffer.entries.filter((e) => !e.isError).length;
  const failed = buffer.entries.filter((e) => e.isError).length;
  const totalHttpTime = buffer.entries.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  lines.push(`Total requests: ${total} | Successful: ${successful} | Failed: ${failed}`);
  lines.push(`Total HTTP time: ${totalHttpTime}ms`);

  // Per-request summary lines
  for (const entry of buffer.entries) {
    const duration =
      entry.durationMs !== null ? (entry.durationMs < 1 ? '<1ms' : `${entry.durationMs}ms`) : 'N/A';
    const failMark = entry.isError ? ' ✗' : '';
    const status = entry.responseStatus ?? 'ERR';
    const actionLabel = entry.apiAction ? ` ${entry.apiAction}` : '';
    // Truncate URL for summary readability
    const shortUrl = entry.url.length > 60 ? entry.url.slice(0, 57) + '...' : entry.url;
    lines.push(
      `  #${entry.id} ${entry.method.padEnd(5)} ${shortUrl} → ${status} ${duration.padStart(6)}${failMark} (${entry.context})${actionLabel}`,
    );
  }

  lines.push('');
  console.error(lines.join('\n'));
}

/** Clear the buffer (used in REPL mode after each command). */
export function clearDebugBuffer(): void {
  buffer.entries = [];
  buffer.diagnostics = [];
  buffer.nextId = 1;
  flushed = false;
}
