/**
 * HTTP transport layer — wraps global fetch with timeout, auth injection,
 * error normalization, and debug redaction.
 */

declare const __VERSION__: string;
// Build-time define (tsup.config.ts, env BUILD_ALLOW_PROXY): gates the proxy
// build variant. False in default builds so the undici branch below is
// constant-folded away and undici never enters the bundle.
declare const __ALLOW_PROXY__: boolean;

import { resolveCredentials } from '../auth/credentials.js';
import { site } from '../site.js';
import { startRequest, endRequest, isEnabled } from './debug-buffer.js';
import { redactPaymentData, redactPaymentError } from '../utils/strings.js';

// Proxy variant: undici's global dispatcher symbol is honored by Node's
// built-in fetch (Node 18-22), so a one-time setGlobalDispatcher routes all
// fetch traffic through HTTP(S)_PROXY / NO_PROXY without per-request wiring.
// The dynamic import stays inside this constant-folded branch so default
// builds eliminate it as dead code. No top-level await: esbuild wraps module
// code in a non-async lazy factory, which would break the Rollup treeshake
// pass — requests await this promise instead so the first one never bypasses
// the proxy.
let proxyInit: Promise<void> | undefined;
if (typeof __ALLOW_PROXY__ !== 'undefined' && __ALLOW_PROXY__) {
  proxyInit = import('undici').then(({ setGlobalDispatcher, EnvHttpProxyAgent }) => {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  });
}

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface BaseClientOptions {
  baseUrl?: string;
  timeout?: number;
}

export interface RequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  authMode?: 'required' | 'optional' | 'none';
  context?: string;
  /** Optional caller cancellation signal, combined with the request timeout. */
  signal?: AbortSignal;
}

export interface BaseClient {
  request<T>(options: RequestOptions): Promise<T>;
}

/** Transport timeout retaining the configured duration for scoped error mapping. */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, url: string) {
    super(`Request timeout after ${timeoutMs / 1000}s\n  URL: ${url}`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Marker for an HTTP-success response whose body is not valid JSON. */
export class ResponseParseError extends Error {
  /**
   * Preserve the parser message and original error without changing the
   * transport's existing top-level network diagnostic.
   *
   * @param cause Error raised while decoding the response body.
   */
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ResponseParseError';
    this.cause = cause;
  }
}

/**
 * Detect the response-parse marker through transport and command wrappers.
 *
 * @param error Error or cause chain to inspect.
 * @returns Whether an HTTP-success response failed JSON decoding.
 */
export function isResponseParseError(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof ResponseParseError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30_000;

function getUserAgent(): string {
  const version = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev';
  return `${site.userAgentPrefix}/${version}`;
}

function redactToken(value: string): string {
  if (value.length <= 10) return '***';
  return value.slice(0, 6) + '***' + value.slice(-4);
}

/**
 * Parse JSON when possible so field-aware payment redaction can run.
 *
 * @param value Raw request or response body.
 * @returns Parsed JSON, the original string, or null for an absent value.
 */
function toDiagnosticValue(value: string | null | undefined): unknown {
  if (value == null) return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Redact a message together with request context.
 *
 * @param message Diagnostic message to sanitize.
 * @param requestBody Request body containing values that may recur in the message.
 * @returns A payment-safe diagnostic message.
 */
function redactMessage(message: string, requestBody?: string): string {
  const safe = redactPaymentData({ requestBody: toDiagnosticValue(requestBody), message }) as {
    message: string;
  };
  return safe.message;
}

/**
 * Produce diagnostic headers without exposing a bearer credential.
 *
 * @param headers Effective request headers.
 * @returns A detached header map with Authorization masked.
 */
function redactDiagnosticHeaders(headers: Record<string, string>): Record<string, unknown> {
  const safeHeaders: Record<string, unknown> = { ...headers };
  if (typeof safeHeaders.Authorization === 'string') {
    safeHeaders.Authorization = `Bearer ${redactToken(safeHeaders.Authorization.replace('Bearer ', ''))}`;
  }
  return safeHeaders;
}

/**
 * Wrap caller cancellation in an AbortError while retaining the exact caller
 * reason as `cause`; this keeps abort classification stable for consumers.
 *
 * @param reason Caller-provided AbortSignal reason.
 * @param fallback Transport error used when the signal has no explicit reason.
 * @param requestBody Serialized request context containing known payment identifiers.
 * @returns An AbortError suitable for service-layer cancellation handling.
 */
function externalAbortError(reason: unknown, fallback: unknown, requestBody?: string): Error {
  const reasonMessage = reason instanceof Error ? reason.message : reason ? String(reason) : '';
  const error = new Error(reasonMessage ? `Request aborted: ${reasonMessage}` : 'Request aborted.');
  error.name = 'AbortError';
  error.cause = reason ?? fallback;
  return redactPaymentError(error, toDiagnosticValue(requestBody));
}

export function createBaseClient(opts?: BaseClientOptions): BaseClient {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

  return {
    async request<T>(options: RequestOptions): Promise<T> {
      const method = options.method ?? 'POST';
      const authMode = options.authMode ?? 'none';
      const context = options.context ?? 'api';

      // Build headers
      const headers: Record<string, string> = {
        'User-Agent': getUserAgent(),
        ...(options.headers ?? {}),
      };

      // Auth injection based on authMode
      if (authMode === 'required') {
        const creds = resolveCredentials();
        if (!creds) {
          throw new Error('Not authenticated. Please login first.');
        }
        headers.Authorization = `Bearer ${creds.access_token}`;
      } else if (authMode === 'optional') {
        const creds = resolveCredentials();
        if (creds) {
          headers.Authorization = `Bearer ${creds.access_token}`;
        }
      }
      // 'none' — no auth header

      // Debug buffer tracking
      const debugEnabled = isEnabled();
      let debugId: number | undefined;
      let diagnosticTerminalRecorded = false;
      if (debugEnabled) {
        // Redact Authorization in debug headers
        const debugHeaders = redactDiagnosticHeaders(headers);
        debugId = startRequest(method, options.url, debugHeaders, options.body ?? null, context);
      }
      // A dedicated controller composes the caller signal with the per-request
      // timeout without transferring listeners between requests.
      const controller = new AbortController();
      let timedOut = false;
      let callerListenerAttached = false;
      const abortFromCaller = (): void => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) {
        abortFromCaller();
      } else {
        if (options.signal) {
          options.signal.addEventListener('abort', abortFromCaller, { once: true });
          callerListenerAttached = true;
        }
      }
      const timer = setTimeout(() => {
        if (controller.signal.aborted) return;
        timedOut = true;
        controller.abort(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      try {
        const requestInit = {
          method,
          headers,
          body: options.body,
          signal: controller.signal,
          redirect: 'error',
        } as const;

        if (proxyInit) await proxyInit;
        const response = await fetch(options.url, requestInit);

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          const safeBodyText = redactMessage(bodyText, options.body);
          const truncated =
            safeBodyText.length > 500
              ? safeBodyText.slice(0, 500) + '...(truncated)'
              : safeBodyText;

          if (debugId !== undefined) {
            endRequest(
              debugId,
              response.status,
              response.statusText,
              truncated,
              true,
              toDiagnosticValue(options.body),
            );
          }
          diagnosticTerminalRecorded = true;

          const parts = [
            `HTTP ${response.status}: ${response.statusText}`,
            `  URL: ${redactMessage(options.url, options.body)}`,
          ];
          if (truncated) parts.push(`  Response: ${truncated}`);
          throw new Error(parts.join('\n'));
        }

        let data: T;
        try {
          data = (await response.json()) as T;
        } catch (error) {
          if (error instanceof SyntaxError) throw new ResponseParseError(error);
          throw error;
        }

        if (debugId !== undefined) {
          const bodyStr = redactMessage(JSON.stringify(data), options.body);
          const truncated = bodyStr.length > 2000 ? bodyStr.slice(0, 2000) : bodyStr;
          endRequest(
            debugId,
            response.status,
            response.statusText,
            truncated,
            false,
            toDiagnosticValue(options.body),
          );
        }
        return data;
      } catch (err) {
        const originalMessage = err instanceof Error ? err.message : String(err);
        const safeMessage = redactMessage(originalMessage, options.body);

        if (!diagnosticTerminalRecorded && debugId !== undefined && err instanceof Error) {
          endRequest(debugId, null, null, safeMessage, true, toDiagnosticValue(options.body));
        }
        // Caller cancellation is semantically distinct from transport timeout;
        // preserve the exact reason so the poller can classify deadline/SIGINT.
        if (options.signal?.aborted && !timedOut) {
          throw externalAbortError(options.signal.reason, err, options.body);
        }
        if (timedOut || (err instanceof Error && err.name === 'AbortError')) {
          throw new RequestTimeoutError(timeout, redactMessage(options.url, options.body));
        }

        // Already a normalized HTTP error from the !response.ok branch above —
        // pass through verbatim so callers see the original status context.
        if (err instanceof Error && /^HTTP \d{3}:/.test(err.message)) {
          throw err;
        }

        // Network-layer failure (DNS, refused, TLS, etc.) — wrap with the
        // legacy diagnostic envelope so error consumers see a stable prefix.
        const baseMsg = safeMessage;
        const cause =
          err instanceof Error && !(err instanceof ResponseParseError) && err.cause
            ? err.cause
            : undefined;
        const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : '';
        const safeCauseMsg = redactMessage(causeMsg, options.body);
        const parts = [
          `Network request failed: ${baseMsg}`,
          `  URL: ${redactMessage(options.url, options.body)}`,
        ];
        if (safeCauseMsg) parts.push(`  Cause: ${safeCauseMsg}`);
        const enriched = new Error(parts.join('\n'));
        if (err instanceof Error) {
          redactPaymentError(err, toDiagnosticValue(options.body));
          enriched.cause = err;
        }
        throw enriched;
      } finally {
        clearTimeout(timer);
        if (callerListenerAttached) {
          options.signal?.removeEventListener('abort', abortFromCaller);
        }
      }
    },
  };
}
