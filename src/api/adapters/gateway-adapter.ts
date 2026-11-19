/**
 * Gateway adapter — stateless helpers that build and parse envelope-protocol payloads.
 */
import { site } from '../../site.js';
import { API_TOKENPLAN_TOOL_CATALOG, API_TOKENPLAN_TOOL_EQUITY } from '../../types/api-routes.js';
import {
  GatewayBusinessError,
  GatewayEnvelopeError,
  GatewayShapeError,
} from '../request-adapter.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface BuildEnvelopePayloadInput {
  api: string;
  data: Record<string, unknown>;
  cornerstoneParam?: Record<string, unknown>;
  switchAgent?: number;
}

export interface EnvelopePayload {
  api: string;
  data: {
    reqDTO: Record<string, unknown>;
    cornerstoneParam: Record<string, unknown>;
  };
  cornerstoneParam: Record<string, unknown>;
}

export interface FlatEnvelopePayload {
  api: string;
  data: Record<string, unknown>;
  cornerstoneParam: Record<string, unknown>;
}

export interface RetError {
  code: string;
  message: string;
}

// ────────────────────────────────────────────────────────────────────
// productCode derivation
// ────────────────────────────────────────────────────────────────────

const FALLBACK_PRODUCT_CODE = 'bailian-platform';
const DEFAULT_LANGUAGE = 'zh-CN';

/**
 * Pick the first dot-separated segment that contains "bailian" (case
 * insensitive). Falls back to a sentinel when no segment matches so callers
 * always observe a non-empty productCode in the envelope.
 */
function deriveProductCode(api: string): string {
  const segments = api.split('.');
  for (const segment of segments) {
    if (/bailian/i.test(segment)) return segment;
  }
  return FALLBACK_PRODUCT_CODE;
}

function deriveDomain(): string {
  try {
    return new URL(site.apiEndpoint).host;
  } catch {
    return site.apiEndpoint;
  }
}

function defaultCornerstoneParam(_api: string): Record<string, unknown> {
  return {
    domain: deriveDomain(),
    consoleSite: 'QIANWENAI',
    console: 'ONE_CONSOLE',
    xsp_lang: DEFAULT_LANGUAGE,
    protocol: 'V2',
    productCode: 'p_efm',
  };
}

// ────────────────────────────────────────────────────────────────────
// buildEnvelopePayload
// ────────────────────────────────────────────────────────────────────

/** Build the structured envelope-protocol payload (returns a fresh object). */
export function buildEnvelopePayload(input: BuildEnvelopePayloadInput): EnvelopePayload {
  const base = input.cornerstoneParam
    ? { ...input.cornerstoneParam }
    : defaultCornerstoneParam(input.api);
  const corner =
    typeof input.switchAgent === 'number' && Number.isFinite(input.switchAgent)
      ? { ...base, switchAgent: input.switchAgent }
      : base;

  return {
    api: input.api,
    data: {
      reqDTO: { ...input.data },
      cornerstoneParam: { ...corner },
    },
    cornerstoneParam: { ...corner },
  };
}

function flatRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayShapeError(`Invalid Harness ${label}`);
  }
  return value as Record<string, unknown>;
}

function assertFlatApi(api: string): void {
  if (api !== API_TOKENPLAN_TOOL_CATALOG && api !== API_TOKENPLAN_TOOL_EQUITY) {
    throw new GatewayShapeError('Unsupported flat envelope API');
  }
}

/** Build the two Harness read envelopes without changing the existing reqDTO protocol. */
export function buildFlatEnvelopePayload(input: BuildEnvelopePayloadInput): FlatEnvelopePayload {
  assertFlatApi(input.api);
  const data = flatRecord(input.data, 'parameters');
  let query: Record<string, unknown> | null = null;
  if (input.api === API_TOKENPLAN_TOOL_CATALOG) {
    if (Object.keys(data).length !== 0)
      throw new GatewayShapeError('Invalid Harness catalog parameters');
  } else {
    query = flatRecord(data.queryTokenPlanEquityInfoRequest, 'equity query');
    if (
      Object.keys(data).length !== 1 ||
      Object.keys(query).length !== 1 ||
      typeof query.requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.requestId)
    ) {
      throw new GatewayShapeError('Invalid Harness equity parameters');
    }
  }
  const base = { ...defaultCornerstoneParam(input.api), ...input.cornerstoneParam };
  const corner =
    typeof input.switchAgent === 'number' && Number.isFinite(input.switchAgent)
      ? { ...base, switchAgent: input.switchAgent }
      : base;
  return {
    api: input.api,
    data: {
      ...(query ? { queryTokenPlanEquityInfoRequest: { ...query } } : {}),
      cornerstoneParam: { ...corner },
    },
    cornerstoneParam: { ...corner },
  };
}

function assertHarnessStatus(business: Record<string, unknown>): void {
  if (
    ('success' in business && business.success !== true) ||
    ('code' in business && business.code !== 'SUCCESS' && business.code !== '200')
  ) {
    throw new GatewayShapeError('Harness business response did not confirm success');
  }
}

/** Parse only the known Harness variants; old gateway callers keep their existing unwrap path. */
export function unwrapFlatEnvelopeResponse(raw: unknown, api: string): unknown {
  assertFlatApi(api);
  const outer = flatRecord(raw, 'response');
  if (typeof outer.code !== 'string')
    throw new GatewayShapeError('Invalid Harness response status');
  if (outer.code !== '200')
    throw new GatewayEnvelopeError(outer.code, 'Harness gateway rejected the request');
  if (outer.successResponse !== true)
    throw new GatewayShapeError('Harness gateway did not confirm success');
  const gateway = flatRecord(outer.data, 'gateway envelope');
  if (
    ('success' in gateway && gateway.success !== true) ||
    ('errorCode' in gateway && gateway.errorCode !== '')
  ) {
    throw new GatewayShapeError('Harness gateway did not confirm success');
  }
  if (api === API_TOKENPLAN_TOOL_CATALOG && !('DataV2' in gateway)) {
    if (typeof gateway.Data !== 'string' || gateway.Data.length > 1_000_000) {
      throw new GatewayShapeError('Harness catalog response is not a JSON string');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(gateway.Data);
    } catch {
      throw new GatewayShapeError('Harness catalog response contains invalid JSON');
    }
    const envelope = flatRecord(decoded, 'catalog envelope');
    if ('api' in envelope && envelope.api !== api)
      throw new GatewayShapeError('Harness catalog API mismatch');
    const business = flatRecord(envelope.data, 'catalog business envelope');
    assertHarnessStatus(business);
    const payload = flatRecord(business.data, 'catalog data');
    if (!Array.isArray(payload.items))
      throw new GatewayShapeError('Harness catalog items are missing');
    return payload;
  }
  const response = flatRecord(gateway.DataV2, 'Harness DataV2');
  if ('api' in response && response.api !== api)
    throw new GatewayShapeError('Harness response API mismatch');
  if (!Array.isArray(response.ret) || typeof response.ret[0] !== 'string') {
    throw new GatewayShapeError('Harness response is missing ret');
  }
  const ret = parseRetError(response.ret[0]);
  if (!isSuccessRet(response.ret[0])) {
    throw new GatewayBusinessError(ret.code || 'GatewayError', 'Harness request failed');
  }
  const business = flatRecord(response.data, 'Harness business envelope');
  assertHarnessStatus(business);
  const payload = flatRecord(business.data, 'Harness data');
  if (api === API_TOKENPLAN_TOOL_CATALOG && !Array.isArray(payload.items))
    throw new GatewayShapeError('Harness catalog items are missing');
  return payload;
}

// ────────────────────────────────────────────────────────────────────
// ret parsing
// ────────────────────────────────────────────────────────────────────

/**
 * Parse a ret string of the form "Code::message". The separator is the FIRST
 * occurrence of "::", so messages may themselves contain "::" verbatim.
 *
 * Edge cases:
 *   - Empty input → { code: '', message: '' }
 *   - No "::" present → { code: <full input>, message: '' }
 */
export function parseRetError(ret: string): RetError {
  if (!ret) return { code: '', message: '' };
  const sep = ret.indexOf('::');
  if (sep < 0) return { code: ret, message: '' };
  return { code: ret.slice(0, sep), message: ret.slice(sep + 2) };
}

/**
 * Detect whether a ret string represents success. The success contract is the
 * literal "SUCCESS::" prefix; anything else (including the empty string) is
 * treated as an error.
 */
export function isSuccessRet(ret: string): boolean {
  return typeof ret === 'string' && ret.startsWith('SUCCESS::');
}

// Internal helper kept available for future productCode-driven routing.
export { deriveProductCode };
