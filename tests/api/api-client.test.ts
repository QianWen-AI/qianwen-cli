/**
 * Tests for ApiClient — both call protocols (flat / envelope).
 *
 * Strategy:
 *   - Inject a stub BaseClient via createApiClient({ baseClient }) so we
 *     avoid mocking global fetch and credentials. The stub records every
 *     RequestOptions it receives and returns whatever the test sets up.
 *   - Mock domain: *.test.qianwen.com (the URL is built from site.apiEndpoint
 *     under the hood, so we only need to assert on body/route shape).
 */
import { describe, it, expect, vi } from 'vitest';
import { createApiClient } from '../../src/api/api-client.js';
import {
  GatewayBusinessError,
  GatewayEnvelopeError,
  GatewayShapeError,
} from '../../src/api/request-adapter.js';
import type { BaseClient, RequestOptions } from '../../src/api/base-client.js';
import type { RawApiEnvelope, GatewayEnvelope } from '../../src/types/api-envelope.js';

interface StubBaseClient extends BaseClient {
  calls: RequestOptions[];
  setResponse(envelope: RawApiEnvelope<unknown>): void;
  setError(err: Error): void;
}

function makeStubBaseClient(): StubBaseClient {
  let response: RawApiEnvelope<unknown> = { code: '200' };
  let error: Error | null = null;
  const calls: RequestOptions[] = [];
  const stub: StubBaseClient = {
    calls,
    setResponse(env) {
      response = env;
      error = null;
    },
    setError(e) {
      error = e;
    },
    request: vi.fn(async <T>(opts: RequestOptions): Promise<T> => {
      calls.push(opts);
      if (error) throw error;
      return response as unknown as T;
    }),
  };
  return stub;
}

// ────────────────────────────────────────────────────────────────────
// callFlatApi
// ────────────────────────────────────────────────────────────────────

describe('ApiClient.callFlatApi', () => {
  it('builds a flat-parameter request and returns the unwrapped data', async () => {
    const base = makeStubBaseClient();
    base.setResponse({ code: '200', data: { Total: 7 } });
    const client = createApiClient({ baseClient: base });

    const out = await client.callFlatApi<{ Total: number }>({
      product: 'AccountCenter',
      action: 'QueryAccountInfoOverview',
      params: { foo: 'bar', n: 1 },
    });

    expect(out).toEqual({ Total: 7 });
    expect(base.calls).toHaveLength(1);
    const sent = base.calls[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.authMode).toBe('required');
    const body = JSON.parse(sent.body!);
    expect(body).toMatchObject({
      product: 'AccountCenter',
      action: 'QueryAccountInfoOverview',
      region: 'cn-beijing',
      params: { foo: 'bar', n: '1' },
    });
  });

  it('accepts the legacy positional form (product, action, params)', async () => {
    const base = makeStubBaseClient();
    base.setResponse({ code: '200', data: { ok: true } });
    const client = createApiClient({ baseClient: base });

    const out = await client.callFlatApi<{ ok: boolean }>('AccountCenter', 'X', { v: 1 });
    expect(out).toEqual({ ok: true });
    const body = JSON.parse(base.calls[0]!.body!);
    expect(body.product).toBe('AccountCenter');
    expect(body.action).toBe('X');
    expect(body.params).toEqual({ v: '1' });
  });

  it('marks AUTH_OPTIONAL_PRODUCTS as authMode=optional', async () => {
    const base = makeStubBaseClient();
    base.setResponse({ code: '200', data: {} });
    const client = createApiClient({ baseClient: base });
    await client.callFlatApi({ product: 'aliyun-search-maas', action: 'SearchAll' });
    expect(base.calls[0]!.authMode).toBe('optional');
  });

  it('honours an explicit authOptional=true flag', async () => {
    const base = makeStubBaseClient();
    base.setResponse({ code: '200', data: {} });
    const client = createApiClient({ baseClient: base });
    await client.callFlatApi({ product: 'X', action: 'Y', authOptional: true });
    expect(base.calls[0]!.authMode).toBe('optional');
  });

  it('throws GatewayEnvelopeError when the gateway returns a non-200 code', async () => {
    const base = makeStubBaseClient();
    base.setResponse({ code: '500', message: 'Server error' });
    const client = createApiClient({ baseClient: base });

    let caught: unknown;
    try {
      await client.callFlatApi({ product: 'p', action: 'a' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayEnvelopeError);
    expect((caught as GatewayEnvelopeError).code).toBe('500');
  });

  it('propagates HTTP errors from the BaseClient verbatim', async () => {
    const base = makeStubBaseClient();
    base.setError(new Error('HTTP 403: Forbidden\n  URL: https://api.test.qianwen.com'));
    const client = createApiClient({ baseClient: base });
    await expect(client.callFlatApi({ product: 'p', action: 'a' })).rejects.toThrow(
      /HTTP 403: Forbidden/,
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// callEnvelopeApi
// ────────────────────────────────────────────────────────────────────

describe('ApiClient.callEnvelopeApi', () => {
  function makeSuccessEnvelope<T>(data: T): RawApiEnvelope<GatewayEnvelope<T>> {
    return {
      code: '200',
      data: {
        DataV2: {
          ret: ['SUCCESS::ok'],
          data: { data, code: 200, success: true, message: 'ok' },
        },
      },
    };
  }

  it('builds an envelope request with reqDTO and the gateway product/action', async () => {
    const base = makeStubBaseClient();
    base.setResponse(makeSuccessEnvelope({ items: ['k1', 'k2'] }));
    const client = createApiClient({ baseClient: base });

    const out = await client.callEnvelopeApi<{ items: string[] }>({
      api: 'zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent',
      data: { pageNo: 1, pageSize: 20 },
    });
    expect(out).toEqual({ items: ['k1', 'k2'] });

    const sent = base.calls[0]!;
    expect(sent.authMode).toBe('required');
    const body = JSON.parse(sent.body!);
    // Outer envelope routing always uses sfm_bailian + BroadScopeAspnGateway.
    expect(body.product).toBe('sfm_bailian');
    expect(body.action).toBe('BroadScopeAspnGateway');
    expect(body.params.Api).toBe('zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent');
    // Inner Data is JSON-encoded and contains reqDTO + cornerstoneParam.
    const innerData = JSON.parse(body.params.Data as string) as Record<string, unknown>;
    expect(innerData.reqDTO).toEqual({ pageNo: 1, pageSize: 20 });
    expect(innerData.cornerstoneParam).toBeTruthy();
  });

  it('honours an explicit cornerstoneParam override', async () => {
    const base = makeStubBaseClient();
    base.setResponse(makeSuccessEnvelope({ ok: true }));
    const client = createApiClient({ baseClient: base });
    const corner = { domain: 'override.test.qianwen.com', protocol: 'V3' };
    await client.callEnvelopeApi({ api: 'a.b.c', data: {}, cornerstoneParam: corner });

    const body = JSON.parse(base.calls[0]!.body!);
    const innerData = JSON.parse(body.params.Data as string) as Record<string, unknown>;
    expect(innerData.cornerstoneParam).toEqual(corner);
  });

  it('throws GatewayBusinessError on a non-success ret tuple', async () => {
    const base = makeStubBaseClient();
    base.setResponse({
      code: '200',
      data: {
        DataV2: {
          ret: ['TOKEN_EXPIRED::Token expired'],
          data: { data: null },
        },
      } as GatewayEnvelope<unknown>,
    });
    const client = createApiClient({ baseClient: base });

    let caught: unknown;
    try {
      await client.callEnvelopeApi({ api: 'a.b', data: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayBusinessError);
    const err = caught as GatewayBusinessError;
    expect(err.code).toBe('TOKEN_EXPIRED');
    expect(err.message).toContain('Token expired');
  });

  it('throws GatewayShapeError when DataV2 and ret are both missing', async () => {
    const base = makeStubBaseClient();
    base.setResponse({ code: '200', data: { unrelated: true } });
    const client = createApiClient({ baseClient: base });
    await expect(client.callEnvelopeApi({ api: 'a.b', data: {} })).rejects.toBeInstanceOf(
      GatewayShapeError,
    );
  });

  it('throws GatewayBusinessError when the ret tuple is empty (synthesized "GatewayError")', async () => {
    const base = makeStubBaseClient();
    base.setResponse({
      code: '200',
      data: { DataV2: { ret: [], data: { data: null } } } as GatewayEnvelope<unknown>,
    });
    const client = createApiClient({ baseClient: base });
    let caught: unknown;
    try {
      await client.callEnvelopeApi({ api: 'a.b', data: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayBusinessError);
    expect((caught as GatewayBusinessError).code).toBe('GatewayError');
  });

  it('throws GatewayEnvelopeError when the outer code is not 200', async () => {
    const base = makeStubBaseClient();
    base.setResponse({ code: '503', message: 'Service unavailable' });
    const client = createApiClient({ baseClient: base });
    await expect(client.callEnvelopeApi({ api: 'a.b', data: {} })).rejects.toBeInstanceOf(
      GatewayEnvelopeError,
    );
  });
});
