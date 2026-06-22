/**
 * Tests for the request-adapter — pure functions that build HTTP payloads
 * for two route types (A=flat, B=envelope) and unwrap raw gateway responses.
 *
 * No HTTP, no auth — just structural transformations and error normalization.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRequest,
  unwrapResponse,
  flattenParams,
  GatewayEnvelopeError,
  GatewayShapeError,
} from '../../src/api/request-adapter.js';
import type { RawApiEnvelope, GatewayEnvelope } from '../../src/types/api-envelope.js';

const GATEWAY_URL_FRAGMENT = '/data/v2/api.json';

// ────────────────────────────────────────────────────────────────────
// flattenParams
// ────────────────────────────────────────────────────────────────────

describe('flattenParams', () => {
  it('passes string values through unchanged', () => {
    expect(flattenParams({ a: 'hello', b: '' })).toEqual({ a: 'hello', b: '' });
  });

  it('coerces numbers, booleans, objects, and arrays to strings', () => {
    expect(flattenParams({ n: 42, b: true, o: { x: 1 }, a: [1, 2] })).toEqual({
      n: '42',
      b: 'true',
      o: '{"x":1}',
      a: '[1,2]',
    });
  });

  it('serializes null and undefined via String()', () => {
    expect(flattenParams({ x: null, y: undefined })).toEqual({ x: 'null', y: 'undefined' });
  });

  it('returns an empty object for an empty input', () => {
    expect(flattenParams({})).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────
// buildRequest — Type A (flat)
// ────────────────────────────────────────────────────────────────────

describe('buildRequest (Type A)', () => {
  it('emits a flat-parameter body with required auth by default', () => {
    const out = buildRequest('A', {
      product: 'AccountCenter',
      action: 'QueryAccountInfoOverview',
      params: { foo: 'bar', n: 1 },
    });
    expect(out.url).toContain(GATEWAY_URL_FRAGMENT);
    expect(out.headers['Content-Type']).toBe('application/json');
    expect(out.authMode).toBe('required');
    expect(out.routeType).toBe('A');
    const body = JSON.parse(out.body);
    expect(body).toEqual({
      product: 'AccountCenter',
      action: 'QueryAccountInfoOverview',
      region: 'cn-beijing',
      params: { foo: 'bar', n: '1' },
    });
  });

  it('honours authOptional=true → authMode optional', () => {
    const out = buildRequest('A', {
      product: 'AccountCenter',
      action: 'X',
      authOptional: true,
    });
    expect(out.authMode).toBe('optional');
  });

  it('marks AUTH_OPTIONAL_PRODUCTS as optional implicitly', () => {
    const out = buildRequest('A', {
      product: 'aliyun-search-maas',
      action: 'SearchAll',
    });
    expect(out.authMode).toBe('optional');
  });

  it('emits an empty params object when params is omitted', () => {
    const out = buildRequest('A', { product: 'p', action: 'a' });
    const body = JSON.parse(out.body);
    expect(body.params).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────
// buildRequest — Type B (envelope)
// ────────────────────────────────────────────────────────────────────

describe('buildRequest (Type B)', () => {
  it('wraps the call in the gateway envelope using API_PRODUCT_GATEWAY/API_ACTION_GATEWAY', () => {
    const out = buildRequest('B', {
      product: '',
      action: '',
      gatewayApi: 'zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent',
      gatewayData: { reqDTO: { pageNo: 1, pageSize: 20 } },
    });

    expect(out.url).toContain(GATEWAY_URL_FRAGMENT);
    expect(out.routeType).toBe('B');

    const body = JSON.parse(out.body);
    expect(body.product).toBe('sfm_bailian');
    expect(body.action).toBe('BroadScopeAspnGateway');
    expect(body.region).toBe('cn-beijing');
    expect(body.params.Api).toBe('zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent');
    expect(body.params.V).toBe('1.0');

    // Data is JSON-stringified.
    expect(typeof body.params.Data).toBe('string');
    expect(JSON.parse(body.params.Data as string)).toEqual({
      reqDTO: { pageNo: 1, pageSize: 20 },
    });
  });

  it('falls back to opts.action when gatewayApi is not provided', () => {
    const out = buildRequest('B', {
      product: '',
      action: 'fallback.api',
    });
    const body = JSON.parse(out.body);
    expect(body.params.Api).toBe('fallback.api');
    expect(body.params.Data).toBe('{}');
  });

  it('serializes cornerstoneParam into the inner params when present', () => {
    const corner = { domain: 'override.test.qianwen.com', protocol: 'V3' };
    const out = buildRequest('B', {
      product: '',
      action: '',
      gatewayApi: 'a.b',
      gatewayData: {},
      cornerstoneParam: corner,
    });
    const body = JSON.parse(out.body);
    expect(JSON.parse(body.params.cornerstoneParam as string)).toEqual(corner);
  });

  it('omits the cornerstoneParam field entirely when not provided', () => {
    const out = buildRequest('B', {
      product: '',
      action: '',
      gatewayApi: 'a.b',
      gatewayData: {},
    });
    const body = JSON.parse(out.body);
    expect(body.params).not.toHaveProperty('cornerstoneParam');
  });
});

// ────────────────────────────────────────────────────────────────────
// unwrapResponse — Type A
// ────────────────────────────────────────────────────────────────────

describe('unwrapResponse (Type A)', () => {
  it('returns the data field on code=200', () => {
    const raw: RawApiEnvelope<{ Data: number[] }> = {
      code: '200',
      data: { Data: [1, 2, 3] },
    };
    const out = unwrapResponse<{ Data: number[] }>('A', raw);
    expect(out.data).toEqual({ Data: [1, 2, 3] });
    expect(out.business).toBeNull();
    expect(out.raw).toBe(raw);
  });

  it('throws GatewayEnvelopeError with the upstream message on non-200 code', () => {
    const raw: RawApiEnvelope = { code: '500', message: 'Internal error' };
    let caught: unknown;
    try {
      unwrapResponse('A', raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayEnvelopeError);
    const err = caught as GatewayEnvelopeError;
    expect(err.code).toBe('500');
    expect(err.message).toBe('Internal error');
  });

  it('falls back to a synthesized message when raw.message is null/undefined', () => {
    const raw: RawApiEnvelope = { code: '403', message: null };
    expect(() => unwrapResponse('A', raw)).toThrow(/code=403/);
  });
});

// ────────────────────────────────────────────────────────────────────
// unwrapResponse — Type B (DataV2 path)
// ────────────────────────────────────────────────────────────────────

describe('unwrapResponse (Type B — DataV2 path)', () => {
  it('extracts the inner business payload on SUCCESS::', () => {
    const envelope: GatewayEnvelope<{ ok: boolean }> = {
      DataV2: {
        ret: ['SUCCESS::workspace listed'],
        data: { data: { ok: true } },
      },
    };
    const raw: RawApiEnvelope<GatewayEnvelope<{ ok: boolean }>> = {
      code: '200',
      data: envelope,
    };
    const out = unwrapResponse<{ ok: boolean }>('B', raw);
    expect(out.data).toEqual({ ok: true });
    expect(out.business).toEqual({ code: 'SUCCESS', message: 'workspace listed' });
  });

  it('returns null data and business={code,message} on a non-success ret', () => {
    const envelope: GatewayEnvelope<unknown> = {
      DataV2: {
        ret: ['TOKEN_EXPIRED::Token expired'],
        data: { data: { stale: true } },
      },
    };
    const raw: RawApiEnvelope<GatewayEnvelope<unknown>> = { code: '200', data: envelope };
    const out = unwrapResponse('B', raw);
    expect(out.data).toBeNull();
    expect(out.business).toEqual({ code: 'TOKEN_EXPIRED', message: 'Token expired' });
  });

  it('returns null data when SUCCESS but inner data.data is missing', () => {
    const envelope: GatewayEnvelope<unknown> = {
      DataV2: {
        ret: ['SUCCESS::ok'],
        data: {},
      },
    };
    const raw: RawApiEnvelope<GatewayEnvelope<unknown>> = { code: '200', data: envelope };
    const out = unwrapResponse('B', raw);
    expect(out.data).toBeNull();
  });

  it('treats an empty ret array as a non-success code "" with empty message', () => {
    const envelope: GatewayEnvelope<unknown> = { DataV2: { ret: [], data: { data: 'x' } } };
    const raw: RawApiEnvelope<GatewayEnvelope<unknown>> = { code: '200', data: envelope };
    const out = unwrapResponse('B', raw);
    expect(out.data).toBeNull();
    expect(out.business).toEqual({ code: '', message: '' });
  });

  it('throws GatewayEnvelopeError when outer code !== 200', () => {
    const raw: RawApiEnvelope = { code: '401', message: 'unauthorized' };
    expect(() => unwrapResponse('B', raw)).toThrow(GatewayEnvelopeError);
  });
});

// ────────────────────────────────────────────────────────────────────
// unwrapResponse — Type B (flat envelope variant)
// ────────────────────────────────────────────────────────────────────

describe('unwrapResponse (Type B — flat variant)', () => {
  it('reads ret/data directly off raw.data when DataV2 is absent', () => {
    const raw: RawApiEnvelope<unknown> = {
      code: '200',
      data: { ret: ['SUCCESS::ok'], data: { items: [1, 2] } },
    };
    const out = unwrapResponse<{ items: number[] }>('B', raw);
    expect(out.data).toEqual({ items: [1, 2] });
    expect(out.business).toEqual({ code: 'SUCCESS', message: 'ok' });
  });

  it('returns null data on a non-success ret in the flat variant', () => {
    const raw: RawApiEnvelope<unknown> = {
      code: '200',
      data: { ret: ['ERR::denied'], data: { items: [] } },
    };
    const out = unwrapResponse('B', raw);
    expect(out.data).toBeNull();
    expect(out.business).toEqual({ code: 'ERR', message: 'denied' });
  });

  it('throws GatewayShapeError when neither DataV2 nor ret are present', () => {
    const raw: RawApiEnvelope<unknown> = { code: '200', data: { unrelated: true } };
    expect(() => unwrapResponse('B', raw)).toThrow(GatewayShapeError);
  });

  it('throws GatewayShapeError when raw.data is undefined', () => {
    const raw: RawApiEnvelope<unknown> = { code: '200' };
    expect(() => unwrapResponse('B', raw)).toThrow(GatewayShapeError);
  });
});
