/** Builds HTTP payloads and unwraps gateway responses. */

import type { RawApiEnvelope, GatewayEnvelope } from '../types/api-envelope.js';
import type { RouteType } from '../types/api-routes.js';
import {
  AUTH_OPTIONAL_PRODUCTS,
  API_PRODUCT_GATEWAY,
  API_ACTION_GATEWAY,
} from '../types/api-routes.js';
import { site } from '../site.js';

// Re-export RouteType for consumers
export type { RouteType } from '../types/api-routes.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface AdapterOptions {
  product: string;
  action: string;
  params?: Record<string, unknown>;
  /** Type B only — overrides default envelope Api field */
  gatewayApi?: string;
  gatewayData?: Record<string, unknown>;
  cornerstoneParam?: Record<string, unknown>;
  authOptional?: boolean;
}

export interface AdapterResult {
  url: string;
  headers: Record<string, string>;
  body: string;
  authMode: 'required' | 'optional';
  routeType: RouteType;
}

export interface UnwrapResult<T> {
  data: T;
  business: { code: string; message: string } | null;
  raw: RawApiEnvelope<unknown>;
}

// ────────────────────────────────────────────────────────────────────
// Error classes
// ────────────────────────────────────────────────────────────────────

export class GatewayEnvelopeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayEnvelopeError';
  }
}

export class GatewayShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayShapeError';
  }
}

/**
 * Type B envelope returned a non-success ret tuple. Carries the parsed
 * business code so the command layer can map well-known codes to
 * user-friendly hints.
 */
export class GatewayBusinessError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayBusinessError';
  }
}

// ────────────────────────────────────────────────────────────────────
// flattenParams — serialize arbitrary values to strings
// ────────────────────────────────────────────────────────────────────

/**
 * Flatten a params dict so every value becomes a string.
 * - string → pass through
 * - number → String(n)
 * - boolean → JSON.stringify(b) ("true" / "false")
 * - object/array → JSON.stringify(v)
 * - other → String(v)
 */
export function flattenParams(params: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      result[key] = value;
    } else if (typeof value === 'number') {
      result[key] = String(value);
    } else if (typeof value === 'boolean') {
      result[key] = JSON.stringify(value);
    } else if (value !== null && value !== undefined && typeof value === 'object') {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// buildRequest — construct HTTP payload for a given route type
// ────────────────────────────────────────────────────────────────────

declare const __NODE_ENV__: string;
const GATEWAY_URL = `${(typeof __NODE_ENV__ === 'undefined' || __NODE_ENV__ !== 'production'
  ? process.env.QIANWEN_API_ENDPOINT || site.apiEndpoint
  : site.apiEndpoint
).replace(/\/+$/, '')}/data/v2/api.json`;
const DEFAULT_REGION = 'cn-beijing';

function resolveAuthMode(opts: AdapterOptions): 'required' | 'optional' {
  if (opts.authOptional === true) return 'optional';
  if (AUTH_OPTIONAL_PRODUCTS.has(opts.product)) return 'optional';
  return 'required';
}

export function buildRequest(routeType: RouteType, opts: AdapterOptions): AdapterResult {
  const authMode = resolveAuthMode(opts);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  let bodyObj: Record<string, unknown>;

  if (routeType === 'B') {
    // Envelope-based routing
    const innerParams: Record<string, string> = {
      Api: opts.gatewayApi ?? opts.action,
      Data: JSON.stringify(opts.gatewayData ?? {}),
      V: '1.0',
    };
    if (opts.cornerstoneParam) {
      innerParams.cornerstoneParam = JSON.stringify(opts.cornerstoneParam);
    }
    bodyObj = {
      product: API_PRODUCT_GATEWAY,
      action: API_ACTION_GATEWAY,
      region: DEFAULT_REGION,
      params: innerParams,
    };
  } else {
    // Flat parameter routing
    const flattened = opts.params ? flattenParams(opts.params) : {};
    bodyObj = {
      product: opts.product,
      action: opts.action,
      region: DEFAULT_REGION,
      params: flattened,
    };
  }

  return {
    url: GATEWAY_URL,
    headers,
    body: JSON.stringify(bodyObj),
    authMode,
    routeType,
  };
}

// ────────────────────────────────────────────────────────────────────
// unwrapResponse — extract business data from raw envelope
// ────────────────────────────────────────────────────────────────────

export function unwrapResponse<T>(
  routeType: RouteType,
  raw: RawApiEnvelope<unknown>,
): UnwrapResult<T> {
  if (routeType === 'A') {
    if (raw.code !== '200') {
      throw new GatewayEnvelopeError(raw.code, raw.message ?? `Gateway error: code=${raw.code}`);
    }
    return {
      data: raw.data as T,
      business: null,
      raw,
    };
  }

  // Multi-level response unwrapping
  if (raw.code !== '200') {
    throw new GatewayEnvelopeError(raw.code, raw.message ?? `Gateway error: code=${raw.code}`);
  }

  const envelope = raw.data as GatewayEnvelope<unknown> | undefined;

  // Standard path: DataV2.ret contains the success/error signal,
  // DataV2.data.data contains the business payload
  if (envelope?.DataV2) {
    const dataV2 = envelope.DataV2;
    const retArr = dataV2.ret;
    const ret = Array.isArray(retArr) ? (retArr[0] ?? '') : '';
    const separatorIdx = ret.indexOf('::');
    const code = separatorIdx >= 0 ? ret.slice(0, separatorIdx) : ret;
    const message = separatorIdx >= 0 ? ret.slice(separatorIdx + 2) : '';

    if (code !== 'SUCCESS') {
      return {
        data: null as T,
        business: { code, message },
        raw,
      };
    }

    // Extract the actual business data from DataV2.data.data
    const innerData = (dataV2.data?.data as T) ?? (null as T);
    return {
      data: innerData,
      business: { code, message },
      raw,
    };
  }

  // Variant path: ret and data sit directly on raw.data (no DataV2 wrapper)
  const flatEnvelope = raw.data as { ret?: string[]; data?: unknown } | undefined;
  if (flatEnvelope?.ret && Array.isArray(flatEnvelope.ret)) {
    const ret = flatEnvelope.ret[0] ?? '';
    const separatorIdx = ret.indexOf('::');
    const code = separatorIdx >= 0 ? ret.slice(0, separatorIdx) : ret;
    const message = separatorIdx >= 0 ? ret.slice(separatorIdx + 2) : '';

    if (code !== 'SUCCESS') {
      return {
        data: null as T,
        business: { code, message },
        raw,
      };
    }

    return {
      data: flatEnvelope.data as T,
      business: { code, message },
      raw,
    };
  }

  throw new GatewayShapeError('Missing DataV2.data in gateway response');
}
