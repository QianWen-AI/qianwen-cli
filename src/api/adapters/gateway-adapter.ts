/**
 * Gateway adapter — stateless helpers that build and parse envelope-protocol payloads.
 */
import { site } from '../../site.js';

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
