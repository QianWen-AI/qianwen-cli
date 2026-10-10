import type { RequestOptions } from '../base-client.js';
import { API_ENDPOINT, GatewayEnvelopeError, GatewayShapeError } from '../request-adapter.js';
import {
  API_ORCHESTRATION_PATH,
  API_PUBLIC_ORCHESTRATION_PATH,
  API_PRODUCT_ORCHESTRATION,
  type OrchestrationPath,
} from '../../types/api-routes.js';

export interface OrchestrationRequestOptions {
  action: string;
  params?: Record<string, unknown>;
  path: OrchestrationPath;
  authMode: 'required' | 'optional' | 'none';
  signal?: AbortSignal;
}

/**
 * Encode only the approved orchestration paths without parameter flattening.
 * @param input Explicit routing, authentication and business parameters.
 * @returns One POST request for the shared transport, without retries.
 * @throws GatewayShapeError when runtime options cannot form a safe request.
 */
export function buildOrchestrationRequest(input: OrchestrationRequestOptions): RequestOptions {
  if (input.path !== API_ORCHESTRATION_PATH && input.path !== API_PUBLIC_ORCHESTRATION_PATH) {
    throw new GatewayShapeError('Unsupported orchestration path');
  }
  if (!['required', 'optional', 'none'].includes(input.authMode)) {
    throw new GatewayShapeError('Explicit orchestration authentication mode is required');
  }
  if (typeof input.action !== 'string' || !input.action.trim()) {
    throw new GatewayShapeError('Orchestration action must be a non-empty string');
  }
  const params = input.params === undefined ? {} : input.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new GatewayShapeError('Orchestration params must be an object');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(params);
  } catch {
    throw new GatewayShapeError('Orchestration params must be JSON-serializable');
  }
  if (typeof serialized !== 'string' || !serialized.startsWith('{')) {
    throw new GatewayShapeError('Orchestration params must serialize to an object');
  }
  const form = new URLSearchParams({
    product: API_PRODUCT_ORCHESTRATION,
    action: input.action,
    region: 'cn-beijing',
    params: serialized,
  });
  return {
    url: `${API_ENDPOINT}${input.path}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    authMode: input.authMode,
    context: 'api',
    signal: input.signal,
  };
}

/**
 * Validate the outer envelope before handing unknown business data to its parser.
 * @param raw Untrusted JSON received from the transport.
 * @param parse Action-specific runtime validator supplied by the caller.
 * @returns The parser result without copying or coercing business data.
 * @throws GatewayEnvelopeError or GatewayShapeError on a rejected envelope.
 */
export function unwrapOrchestrationResponse<T>(raw: unknown, parse: (data: unknown) => T): T {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GatewayShapeError('Invalid orchestration response envelope');
  }
  if (!('code' in raw) || typeof raw.code !== 'string') {
    throw new GatewayShapeError('Orchestration response code must be a string');
  }
  if (raw.code !== '200' || ('successResponse' in raw && raw.successResponse === false)) {
    const message =
      'message' in raw && typeof raw.message === 'string'
        ? raw.message
        : 'Orchestration gateway rejected the request';
    throw new GatewayEnvelopeError(raw.code, message);
  }
  if (!('data' in raw)) {
    throw new GatewayShapeError('Orchestration response missing data');
  }
  return parse(raw.data);
}
