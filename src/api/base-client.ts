/**
 * HTTP transport layer — wraps global fetch with timeout, auth injection,
 * error normalization, and debug redaction.
 */

declare const __VERSION__: string;

import { resolveCredentials } from '../auth/credentials.js';
import { site } from '../site.js';
import { startRequest, endRequest, isEnabled } from './debug-buffer.js';

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
}

export interface BaseClient {
  request<T>(options: RequestOptions): Promise<T>;
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
      if (debugEnabled) {
        // Redact Authorization in debug headers
        const debugHeaders: Record<string, unknown> = { ...headers };
        if (debugHeaders.Authorization && typeof debugHeaders.Authorization === 'string') {
          debugHeaders.Authorization = `Bearer ${redactToken((debugHeaders.Authorization as string).replace('Bearer ', ''))}`;
        }
        debugId = startRequest(method, options.url, debugHeaders, options.body ?? null, context);
      }

      // AbortController for timeout
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      try {
        const response = await fetch(options.url, {
          method,
          headers,
          body: options.body,
          signal: controller.signal,
          redirect: 'error',
        });

        clearTimeout(timer);

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          const truncated =
            bodyText.length > 500 ? bodyText.slice(0, 500) + '...(truncated)' : bodyText;

          if (debugId !== undefined) {
            endRequest(debugId, response.status, response.statusText, truncated, true);
          }

          const parts = [
            `HTTP ${response.status}: ${response.statusText}`,
            `  URL: ${options.url}`,
          ];
          if (truncated) parts.push(`  Response: ${truncated}`);
          throw new Error(parts.join('\n'));
        }

        const data = (await response.json()) as T;

        if (debugId !== undefined) {
          const bodyStr = JSON.stringify(data);
          const truncated = bodyStr.length > 2000 ? bodyStr.slice(0, 2000) : bodyStr;
          endRequest(debugId, response.status, response.statusText, truncated, false);
        }

        return data;
      } catch (err) {
        clearTimeout(timer);

        if (debugId !== undefined && err instanceof Error) {
          endRequest(debugId, null, null, err.message, true);
        }

        // Re-throw with normalized message for abort/timeout
        if (err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted)) {
          throw new Error(`Request timeout after ${timeout / 1000}s\n  URL: ${options.url}`);
        }

        // Already a normalized HTTP error from the !response.ok branch above —
        // pass through verbatim so callers see the original status context.
        if (err instanceof Error && /^HTTP \d{3}:/.test(err.message)) {
          throw err;
        }

        // Network-layer failure (DNS, refused, TLS, etc.) — wrap with the
        // legacy diagnostic envelope so error consumers see a stable prefix.
        const baseMsg = err instanceof Error ? err.message : String(err);
        const cause = err instanceof Error && err.cause ? err.cause : undefined;
        const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : '';
        const parts = [`Network request failed: ${baseMsg}`, `  URL: ${options.url}`];
        if (causeMsg) parts.push(`  Cause: ${causeMsg}`);
        const enriched = new Error(parts.join('\n'));
        if (err instanceof Error) enriched.cause = err;
        throw enriched;
      }
    },
  };
}
