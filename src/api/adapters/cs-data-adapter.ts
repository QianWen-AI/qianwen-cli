import type { RequestOptions } from '../base-client.js';
import { GatewayEnvelopeError, GatewayShapeError } from '../request-adapter.js';
import {
  API_ACTION_GATEWAY,
  API_PRODUCT_GATEWAY,
  API_TOKENPLAN_SOLO_QUOTA_CONFIG,
  API_TOKENPLAN_SOLO_SUBSCRIPTION,
  API_TOKENPLAN_SOLO_USAGE,
  API_VERSION_GATEWAY,
} from '../../types/api-routes.js';
import { CliError } from '../../utils/errors.js';
import { site } from '../../site.js';

export interface CsDataRequestOptions {
  api: string;
  data?: Record<string, unknown>;
  endpoint?: string;
  authMode?: 'required' | 'none';
}

export class CsDataAuthenticationError extends CliError {
  constructor() {
    super({
      code: 'CS_DATA_AUTH_REQUIRED',
      message: 'cs-data authentication rejected. Run: qianwen auth login',
      exitCode: 2,
    });
    this.name = 'CsDataAuthenticationError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayShapeError(`Invalid cs-data ${label}`);
  }
  return value as Record<string, unknown>;
}

export function buildCsDataRequest(input: CsDataRequestOptions): RequestOptions {
  if (
    input.api !== API_TOKENPLAN_SOLO_SUBSCRIPTION &&
    input.api !== API_TOKENPLAN_SOLO_QUOTA_CONFIG &&
    input.api !== API_TOKENPLAN_SOLO_USAGE
  ) {
    throw new GatewayShapeError('Unsupported cs-data API');
  }
  const authMode = input.authMode ?? 'required';
  if (
    (authMode !== 'required' && authMode !== 'none') ||
    (authMode === 'none' && input.api !== API_TOKENPLAN_SOLO_QUOTA_CONFIG)
  ) {
    throw new GatewayShapeError('Unsupported cs-data authentication mode');
  }
  const data = input.data === undefined ? {} : record(input.data, 'parameters');
  if (
    input.api === API_TOKENPLAN_SOLO_SUBSCRIPTION
      ? Object.keys(data).length !== 1 ||
        data.commodityCode !== site.features.tokenPlanCommodityCodes.soloBuy
      : Object.keys(data).length !== 0
  ) {
    throw new GatewayShapeError('Invalid cs-data API parameters');
  }
  let url: URL;
  try {
    url = new URL(input.endpoint ?? site.csDataEndpoint.replace(/\/+$/, ''));
  } catch {
    throw new GatewayShapeError('Invalid cs-data endpoint');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/', '/cli/api.json'].includes(url.pathname) ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new GatewayShapeError('Invalid cs-data endpoint');
  }
  url.pathname = '/cli/api.json';
  url.search = new URLSearchParams({
    action: API_ACTION_GATEWAY,
    product: API_PRODUCT_GATEWAY,
    api: input.api,
  }).toString();
  const params = {
    Api: input.api,
    V: API_VERSION_GATEWAY,
    Data: {
      ...data,
      cornerstoneParam: {
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        switchUserType: 3,
        consoleSite: 'QIANWENAI',
      },
    },
  };
  return {
    url: url.toString(),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ params: JSON.stringify(params), region: 'cn-beijing' }).toString(),
    authMode,
    context: 'cs-data',
  };
}

export function unwrapCsDataResponse(raw: unknown): unknown {
  const outer = record(raw, 'response');
  if (typeof outer.code !== 'string' || typeof outer.successResponse !== 'boolean') {
    throw new GatewayShapeError('Invalid cs-data response status');
  }
  if (outer.code !== '200' || outer.successResponse !== true) {
    throw new GatewayEnvelopeError(outer.code, 'cs-data gateway rejected the request');
  }
  const gateway = record(outer.data, 'gateway envelope');
  if (gateway.success === false && gateway.errorCode === 'BailianGateway.Login.NotLogined') {
    throw new CsDataAuthenticationError();
  }
  if (gateway.success !== true || ('errorCode' in gateway && gateway.errorCode !== '')) {
    throw new GatewayShapeError('cs-data gateway did not confirm success');
  }
  const payload = record(gateway.DataV2, 'DataV2');
  if (
    !Array.isArray(payload.ret) ||
    typeof payload.ret[0] !== 'string' ||
    !payload.ret[0].startsWith('SUCCESS::')
  ) {
    throw new GatewayShapeError('cs-data response missing successful ret');
  }
  const business = record(payload.data, 'business envelope');
  if (business.code !== 'SUCCESS' || business.success !== true) {
    throw new GatewayShapeError('cs-data business response did not confirm success');
  }
  return business;
}
