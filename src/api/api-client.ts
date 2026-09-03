/**
 * ApiClient — unified call entry point for the gateway.
 *
 * Supports flat-parameter protocol (callFlatApi) and envelope protocol
 * (callEnvelopeApi). Errors are normalized into typed Error instances.
 */
import { createBaseClient, type BaseClient } from './base-client.js';
import {
  buildRequest,
  unwrapResponse,
  GatewayShapeError,
  GatewayBusinessError,
} from './request-adapter.js';
import { buildEnvelopePayload, isSuccessRet, parseRetError } from './adapters/gateway-adapter.js';
import type { RawApiEnvelope } from '../types/api-envelope.js';
import { redactPaymentError } from '../utils/strings.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Associate request/response billing identity with a protocol error so the
 * final diagnostic sink can redact a detached copy without mutating the Error.
 *
 * @param error Error raised while unwrapping a gateway response.
 * @param requestBody Serialized request body containing the known identity.
 * @param responseBody Decoded response that may repeat the identity.
 * @returns The unchanged error instance with registered redaction context.
 */
function registerProtocolErrorContext(
  error: unknown,
  requestBody: string,
  responseBody: unknown,
): unknown {
  if (!(error instanceof Error)) return error;
  let requestContext: unknown = requestBody;
  try {
    requestContext = JSON.parse(requestBody);
  } catch {
    // The serialized request is still useful to the free-text sanitizer.
  }
  return redactPaymentError(error, { request: requestContext, response: responseBody });
}

export interface CallFlatApiOptions {
  product: string;
  action: string;
  params?: Record<string, unknown>;
  /** Attach a Bearer token when logged in, omit silently otherwise. */
  authOptional?: boolean;
  /** Cancel this request without serializing the signal into API params. */
  signal?: AbortSignal;
}

export interface CallEnvelopeApiOptions {
  api: string;
  data: Record<string, unknown>;
  cornerstoneParam?: Record<string, unknown>;
  /** Tenant ID for cross-workspace queries. */
  switchAgent?: number;
}

export interface ApiClient {
  callFlatApi<T>(opts: CallFlatApiOptions): Promise<T>;
  callFlatApi<T>(product: string, action: string, params?: Record<string, unknown>): Promise<T>;
  callEnvelopeApi<T>(opts: CallEnvelopeApiOptions): Promise<T>;
}

export interface CreateApiClientOptions {
  /** Inject a custom BaseClient (test seam); a default is created otherwise. */
  baseClient?: BaseClient;
  /** Override the default request timeout (ms). */
  timeoutMs?: number;
}

// ────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────

export function createApiClient(opts?: CreateApiClientOptions): ApiClient {
  const base =
    opts?.baseClient ?? createBaseClient({ timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  return {
    async callFlatApi<T>(
      productOrOpts: string | CallFlatApiOptions,
      action?: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      const input: CallFlatApiOptions =
        typeof productOrOpts === 'string'
          ? { product: productOrOpts, action: action!, params }
          : productOrOpts;
      const adapted = buildRequest('A', {
        product: input.product,
        action: input.action,
        params: input.params,
        authOptional: input.authOptional,
      });
      const raw = await base.request<RawApiEnvelope<unknown>>({
        url: adapted.url,
        method: 'POST',
        headers: adapted.headers,
        body: adapted.body,
        authMode: adapted.authMode,
        context: 'api',
        signal: input.signal,
      });
      try {
        const { data } = unwrapResponse<T>('A', raw);
        return data;
      } catch (error) {
        throw registerProtocolErrorContext(error, adapted.body, raw);
      }
    },

    async callEnvelopeApi<T>(input: CallEnvelopeApiOptions): Promise<T> {
      // Build the proper envelope structure: { reqDTO, cornerstoneParam }
      const envelopePayload = buildEnvelopePayload({
        api: input.api,
        data: input.data,
        cornerstoneParam: input.cornerstoneParam,
        switchAgent: input.switchAgent,
      });

      const adapted = buildRequest('B', {
        product: '',
        action: '',
        gatewayApi: input.api,
        gatewayData: envelopePayload.data,
      });

      const raw = await base.request<RawApiEnvelope<unknown>>({
        url: adapted.url,
        method: 'POST',
        headers: adapted.headers,
        body: adapted.body,
        authMode: adapted.authMode,
        context: 'api',
      });

      // unwrapResponse('B', …) throws GatewayShapeError when DataV2 or its
      // .data payload are missing, but does NOT throw for empty/non-success
      // ret; we surface those here as standard Error instances.
      const result = unwrapResponse<T>('B', raw);
      const business = result.business;
      if (!business) {
        throw new GatewayShapeError('Envelope response missing business status');
      }
      const retString = `${business.code}${business.code ? '::' : ''}${business.message}`;
      if (!isSuccessRet(retString)) {
        const parsed = parseRetError(retString);
        const display = parsed.message
          ? `${parsed.code || 'GatewayError'}: ${parsed.message}`
          : parsed.code || 'Gateway business error: empty ret';
        throw new GatewayBusinessError(parsed.code || 'GatewayError', display);
      }
      return result.data;
    },
  };
}
