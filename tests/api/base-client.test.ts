/**
 * Tests for the BaseClient — wraps global fetch with timeout / auth /
 * error normalization / debug redaction.
 *
 * Strategy:
 *   - Mock the credential layer so resolveCredentials() returns a fake
 *     bearer token (or null) deterministically.
 *   - Stub global fetch via mockFetch() to drive every HTTP path.
 *   - Use the *.test.qianwen.com mock domain across the suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetch, type MockFetch } from '../helpers/http-mock.js';

// ── Hoisted mocks ────────────────────────────────────────────────────
// resolveCredentials must be mockable per-test; the default returns a
// bearer token so the 'required' branch succeeds without further setup.

const credentialState: { value: { access_token: string } | null } = {
  value: {
    access_token: 'fake-bearer-token-1234567890ABCDEF',
  },
};

vi.mock('../../src/auth/credentials.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    resolveCredentials: vi.fn(() => credentialState.value),
  };
});

import { createBaseClient } from '../../src/api/base-client.js';

const URL_OK = 'https://api.test.qianwen.com/data/v2/api.json';

let active: MockFetch | null = null;

beforeEach(() => {
  credentialState.value = {
    access_token: 'fake-bearer-token-1234567890ABCDEF',
  };
});

afterEach(() => {
  if (active) {
    active.restore();
    active = null;
  }
});

// ────────────────────────────────────────────────────────────────────
// Headers, body, default method
// ────────────────────────────────────────────────────────────────────

describe('BaseClient.request — request building', () => {
  it('uses POST by default and forwards body verbatim', async () => {
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await client.request({ url: URL_OK, body: '{"product":"x"}' });

    expect(active.calls).toHaveLength(1);
    expect(active.calls[0]?.method).toBe('POST');
    expect(active.calls[0]?.body).toBe('{"product":"x"}');
  });

  it('attaches a User-Agent header from site.userAgentPrefix', async () => {
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await client.request({ url: URL_OK });

    const ua = active.calls[0]?.headers['User-Agent'];
    expect(ua).toBeTruthy();
    expect(ua).toMatch(/\/\d/); // "<prefix>/<version>" shape
  });

  it('merges caller-supplied headers without dropping User-Agent', async () => {
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await client.request({
      url: URL_OK,
      headers: { 'Content-Type': 'application/json', 'X-Trace-Id': 'abc-123' },
    });
    expect(active.calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(active.calls[0]?.headers['X-Trace-Id']).toBe('abc-123');
    expect(active.calls[0]?.headers['User-Agent']).toBeTruthy();
  });

  it('forwards a custom HTTP method when specified', async () => {
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await client.request({ url: URL_OK, method: 'PUT' });
    expect(active.calls[0]?.method).toBe('PUT');
  });
});

// ────────────────────────────────────────────────────────────────────
// authMode
// ────────────────────────────────────────────────────────────────────

describe('BaseClient.request — authMode', () => {
  it('omits Authorization in the default (none) mode', async () => {
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await client.request({ url: URL_OK });
    expect(active.calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('attaches Bearer token when authMode=required and creds exist', async () => {
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await client.request({ url: URL_OK, authMode: 'required' });
    expect(active.calls[0]?.headers.Authorization).toBe(
      'Bearer fake-bearer-token-1234567890ABCDEF',
    );
  });

  it('throws "Not authenticated" when authMode=required and creds are missing', async () => {
    credentialState.value = null;
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await expect(client.request({ url: URL_OK, authMode: 'required' })).rejects.toThrow(
      /Not authenticated/,
    );
    // No fetch should have been issued because the auth check fails first.
    expect(active.calls).toHaveLength(0);
  });

  it('attaches Bearer when authMode=optional and creds exist', async () => {
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await client.request({ url: URL_OK, authMode: 'optional' });
    expect(active.calls[0]?.headers.Authorization).toMatch(/^Bearer /);
  });

  it('omits Authorization silently when authMode=optional and creds are missing', async () => {
    credentialState.value = null;
    active = mockFetch({ 'api.test.qianwen.com': { code: '200' } });
    const client = createBaseClient();
    await client.request({ url: URL_OK, authMode: 'optional' });
    expect(active.calls).toHaveLength(1);
    expect(active.calls[0]?.headers.Authorization).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Response parsing
// ────────────────────────────────────────────────────────────────────

describe('BaseClient.request — response parsing', () => {
  it('returns the parsed JSON body on a 2xx response', async () => {
    active = mockFetch({ 'api.test.qianwen.com': { code: '200', data: { ok: true } } });
    const client = createBaseClient();
    const out = await client.request<{ code: string; data: { ok: boolean } }>({
      url: URL_OK,
    });
    expect(out).toEqual({ code: '200', data: { ok: true } });
  });
});

// ────────────────────────────────────────────────────────────────────
// Error normalization
// ────────────────────────────────────────────────────────────────────

describe('BaseClient.request — error normalization', () => {
  it('throws a "HTTP <status>:" error on non-2xx responses', async () => {
    active = mockFetch({
      'api.test.qianwen.com': {
        body: { error: 'denied' },
        init: { status: 403, statusText: 'Forbidden' },
      },
    });
    const client = createBaseClient();
    await expect(client.request({ url: URL_OK })).rejects.toThrow(/^HTTP 403: Forbidden/);
  });

  it('truncates large response bodies in the HTTP error message', async () => {
    const big = 'x'.repeat(800);
    active = mockFetch({
      'api.test.qianwen.com': { body: big, init: { status: 500, statusText: 'Server Error' } },
    });
    const client = createBaseClient();
    let err: Error | undefined;
    try {
      await client.request({ url: URL_OK });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Body section should be truncated with "...(truncated)" suffix.
    expect(err!.message).toMatch(/\.\.\.\(truncated\)/);
  });

  it('wraps network-layer failures with the legacy "Network request failed:" prefix', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      const client = createBaseClient();
      await expect(client.request({ url: URL_OK })).rejects.toThrow(
        /^Network request failed: ECONNREFUSED/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('normalizes timeout errors to "Request timeout after Ns"', async () => {
    // Simulate a fetch that respects AbortSignal.
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    ) as unknown as typeof fetch;
    try {
      const client = createBaseClient({ timeout: 50 });
      await expect(client.request({ url: URL_OK })).rejects.toThrow(/Request timeout after/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Redirect handling — credentials must not follow redirects
// ────────────────────────────────────────────────────────────────────

describe('BaseClient.request — redirect option', () => {
  it('passes redirect: "error" to fetch to prevent credential leakage on redirects', async () => {
    const previous = globalThis.fetch;
    const recordingFetch = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: '200' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = recordingFetch as unknown as typeof fetch;

    try {
      const client = createBaseClient();
      await client.request({
        url: URL_OK,
        authMode: 'required',
      });
      expect(recordingFetch).toHaveBeenCalledTimes(1);
      const init = recordingFetch.mock.calls[0]?.[1];
      expect(init?.redirect).toBe('error');
    } finally {
      globalThis.fetch = previous;
    }
  });
});
