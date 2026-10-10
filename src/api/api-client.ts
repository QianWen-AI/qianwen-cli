/**
 * ApiClient — unified call entry point for the gateway.
 *
 * Supports flat-parameter protocol (callFlatApi) and envelope protocol
 * (callEnvelopeApi). Errors are normalized into typed Error instances.
 */
import {
  createBaseClient,
  HttpResponseError,
  RequestTimeoutError,
  isResponseParseError,
  type BaseClient,
  type RequestOptions,
} from './base-client.js';
import {
  buildRequest,
  unwrapResponse,
  GatewayShapeError,
  GatewayBusinessError,
  API_ENDPOINT,
} from './request-adapter.js';
import {
  buildCsDataRequest,
  unwrapCsDataResponse,
  CsDataAuthenticationError,
} from './adapters/cs-data-adapter.js';
import {
  acquireCsDataSession,
  createCsDataBudget,
  currentCsDataSession,
  checkCsDataSignal,
  awaitCsDataOperation,
  invalidateCsDataCredential,
  type CsDataSession,
} from '../auth/cs-data-session.js';
import type { CsDataContext } from '../types/auth.js';
import {
  API_PRODUCT_MODEL_STUDIO_REGIONAL,
  API_ACTION_GENERATE_CLI_ACCESS_TOKEN,
  API_VERSION_GENERATE_CLI_ACCESS_TOKEN,
} from '../types/api-routes.js';
import { CliError, authRequiredError } from '../utils/errors.js';
import { site } from '../site.js';
import { isCredentialToken } from '../auth/credential-token.js';
import { buildEnvelopePayload, isSuccessRet, parseRetError } from './adapters/gateway-adapter.js';
import {
  buildOrchestrationRequest,
  unwrapOrchestrationResponse,
  type OrchestrationRequestOptions,
} from './adapters/orchestration-adapter.js';
import type { RawApiEnvelope } from '../types/api-envelope.js';
import { redactPaymentError } from '../utils/strings.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Detect pre-response transport failures that warrant a single silent retry
 * inside the cs-data gateway path.
 *
 * The cs-data gateway intermittently 302-reroutes CLI requests to an error
 * page; the transport rejects those via `redirect: 'error'` and surfaces a
 * wrapped `Network request failed` error. Read timeouts share the same
 * intermittent characteristic. HTTP status errors, gateway business errors,
 * authentication rejections, shape errors and caller cancellation are NOT
 * retried here — each has its own dedicated recovery path.
 *
 * @param error Error raised while performing a cs-data gateway request.
 * @param signal cs-data budget signal; an aborted budget suppresses retry.
 * @returns Whether a single silent retry should be attempted.
 */
function isTransportRetryable(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (error instanceof RequestTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  if (error instanceof CliError || error instanceof HttpResponseError) return false;
  if (error.name === 'AbortError' || isResponseParseError(error)) return false;
  return /^Network request failed:/.test(error.message);
}

async function requestCsDataWithRetry<T>(
  base: BaseClient,
  request: RequestOptions,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await awaitCsDataOperation(base.request<T>({ ...request, signal }), signal);
  } catch (error) {
    if (!isTransportRetryable(error, signal)) throw error;
    checkCsDataSignal(signal);
    return await awaitCsDataOperation(base.request<T>({ ...request, signal }), signal);
  }
}

/**
 * Associate request/response diagnostic context with a protocol error so the
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
  /** Optional API version at the request root, never inside params. */
  version?: string;
  params?: Record<string, unknown>;
  /** Attach a Bearer token when logged in, omit silently otherwise. */
  authOptional?: boolean;
  /** Cancel this request without serializing the signal into API params. */
  signal?: AbortSignal;
  /** Called at the transport boundary immediately before fetch is invoked. */
  onRequestStart?: () => void;
  authorization?: { bearerToken: string };
}

export interface CallCsDataApiOptions<T> {
  api: string;
  data?: Record<string, unknown>;
  /** Only the explicitly allowlisted account-scoped API may opt out of authentication. */
  authMode?: 'required' | 'none';
  signal?: AbortSignal;
  parse: (business: unknown) => T;
}

export interface CallEnvelopeApiOptions {
  api: string;
  data: Record<string, unknown>;
  cornerstoneParam?: Record<string, unknown>;
  /** Tenant ID for cross-workspace queries. */
  switchAgent?: number;
  /** Cancel transport work without modifying the gateway envelope. */
  signal?: AbortSignal;
}

export interface CallOrchestrationApiOptions<T> extends OrchestrationRequestOptions {
  /** Validate unknown business data; generic types alone do not establish its shape. */
  parse: (data: unknown) => T;
}

export interface ApiClient {
  callFlatApi<T>(opts: CallFlatApiOptions): Promise<T>;
  callFlatApi<T>(product: string, action: string, params?: Record<string, unknown>): Promise<T>;
  callEnvelopeApi<T>(opts: CallEnvelopeApiOptions): Promise<T>;
  callCsDataApi<T>(opts: CallCsDataApiOptions<T>): Promise<T>;
  /**
   * Make one authenticated-as-configured form request and validate its response.
   * @param opts Restricted route, explicit auth, parameters and runtime parser.
   * @returns Validated business data; no retry or fallback is performed.
   */
  callOrchestrationApi<T>(opts: CallOrchestrationApiOptions<T>): Promise<T>;
}

export interface CreateApiClientOptions {
  /** Inject a custom BaseClient (test seam); a default is created otherwise. */
  baseClient?: BaseClient;
  /** Override the default request timeout (ms). */
  timeoutMs?: number;
  csDataContext?: CsDataContext;
}

function defaultCsDataContext(): CsDataContext {
  if (API_ENDPOINT !== site.apiEndpoint.replace(/\/+$/, '')) {
    throw new CliError({
      code: 'CS_DATA_ENDPOINT_UNSUPPORTED',
      message: 'cs-data access is unavailable for the configured API endpoint.',
      exitCode: 4,
    });
  }
  return {
    issuer: `${API_ENDPOINT}/data/v2/api.json`,
    gateway: `${site.csDataEndpoint.replace(/\/+$/, '')}/cli/api.json`,
    environment: 'production',
    region: 'cn-beijing',
    site: site.key,
  };
}

// ────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────

export function createApiClient(opts?: CreateApiClientOptions): ApiClient {
  const base =
    opts?.baseClient ?? createBaseClient({ timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  const client: ApiClient = {
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
        version: input.version,
        params: input.params,
        authOptional: input.authOptional,
      });
      const raw = await base.request<RawApiEnvelope<unknown>>({
        url: adapted.url,
        method: 'POST',
        headers: {
          ...adapted.headers,
          ...(input.authorization
            ? { Authorization: `Bearer ${input.authorization.bearerToken}` }
            : {}),
        },
        body: adapted.body,
        authMode: input.authorization ? 'none' : adapted.authMode,
        context: 'api',
        signal: input.signal,
        onRequestStart: input.onRequestStart,
      });
      try {
        const { data } = unwrapResponse<T>('A', raw);
        if (
          input.product === API_PRODUCT_MODEL_STUDIO_REGIONAL &&
          input.action === API_ACTION_GENERATE_CLI_ACCESS_TOKEN &&
          raw.successResponse !== true
        ) {
          throw new GatewayShapeError('Token issuance did not confirm success');
        }
        return data;
      } catch (error) {
        if (error instanceof Error && input.authorization) {
          redactPaymentError(error, { access_token: input.authorization.bearerToken });
        }
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
        signal: input.signal,
      });

      // unwrapResponse('B', …) throws GatewayShapeError when DataV2 or its
      // .data payload are missing, but does NOT throw for empty/non-success
      // ret; we surface those here as standard Error instances.
      try {
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
      } catch (error) {
        throw registerProtocolErrorContext(error, adapted.body, raw);
      }
    },

    async callCsDataApi<T>(input: CallCsDataApiOptions<T>): Promise<T> {
      if (!input || typeof input.parse !== 'function') {
        throw new GatewayShapeError('cs-data response parser is required');
      }
      const context = opts?.csDataContext ?? defaultCsDataContext();
      if (
        context.issuer !== `${API_ENDPOINT}/data/v2/api.json` ||
        context.region !== 'cn-beijing' ||
        context.site !== site.key
      ) {
        throw new CliError({
          code: 'CS_DATA_BINDING_INVALID',
          message: 'cs-data credential binding does not match the active API route.',
          exitCode: 4,
        });
      }
      const adapted = buildCsDataRequest({ ...input, endpoint: context.gateway });
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const budget = createCsDataBudget(input.signal, timeoutMs);
      if (adapted.authMode === 'none') {
        let raw: unknown;
        try {
          checkCsDataSignal(budget.signal);
          raw = await requestCsDataWithRetry<unknown>(base, adapted, budget.signal);
          const business = unwrapCsDataResponse(raw);
          return await awaitCsDataOperation(Promise.resolve(input.parse(business)), budget.signal);
        } catch (error) {
          throw registerProtocolErrorContext(error, adapted.body ?? '', raw);
        } finally {
          budget.dispose();
        }
      }
      const issue = async (session: CsDataSession, signal: AbortSignal): Promise<string> => {
        const raw = await client.callFlatApi<unknown>({
          product: API_PRODUCT_MODEL_STUDIO_REGIONAL,
          action: API_ACTION_GENERATE_CLI_ACCESS_TOKEN,
          version: API_VERSION_GENERATE_CLI_ACCESS_TOKEN,
          params: {},
          signal,
          authorization: { bearerToken: session.credentials.access_token },
        });
        if (
          !raw ||
          typeof raw !== 'object' ||
          !('cliAccessToken' in raw) ||
          !isCredentialToken(raw.cliAccessToken) ||
          raw.cliAccessToken === session.credentials.access_token
        )
          throw new GatewayShapeError('Token issuance returned an invalid derived credential');
        return raw.cliAccessToken;
      };
      const invoke = async (expected: CsDataSession): Promise<T> => {
        const session = currentCsDataSession(context, expected, budget.signal);
        if (!session.token) throw authRequiredError();
        let raw: unknown;
        try {
          raw = await requestCsDataWithRetry<unknown>(
            base,
            {
              ...adapted,
              headers: { ...adapted.headers, Authorization: `Bearer ${session.token}` },
              authMode: 'none',
            },
            budget.signal,
          );
          const business = unwrapCsDataResponse(raw);
          const parsed = await awaitCsDataOperation(
            Promise.resolve(input.parse(business)),
            budget.signal,
          );
          currentCsDataSession(context, session, budget.signal);
          return parsed;
        } catch (error) {
          if (error instanceof Error) {
            redactPaymentError(error, {
              access_token: session.credentials.access_token,
              cliAccessToken: session.token,
            });
          }
          throw registerProtocolErrorContext(error, adapted.body ?? '', raw);
        }
      };
      try {
        checkCsDataSignal(budget.signal);
        const acquired = await acquireCsDataSession(
          context,
          issue,
          budget.signal,
          budget.remaining(),
        );
        try {
          return await invoke(acquired.session);
        } catch (error) {
          if (!(error instanceof CsDataAuthenticationError)) throw error;
          checkCsDataSignal(budget.signal);
          if (acquired.fresh) {
            invalidateCsDataCredential(acquired.session);
            throw error;
          }
          const refreshed = await acquireCsDataSession(
            context,
            issue,
            budget.signal,
            budget.remaining(),
            acquired.session,
          );
          try {
            return await invoke(refreshed.session);
          } catch (retryError) {
            if (retryError instanceof CsDataAuthenticationError) {
              invalidateCsDataCredential(refreshed.session);
            }
            throw retryError;
          }
        }
      } finally {
        budget.dispose();
      }
    },

    async callOrchestrationApi<T>(input: CallOrchestrationApiOptions<T>): Promise<T> {
      if (!input || typeof input.parse !== 'function') {
        throw new GatewayShapeError('Orchestration response parser is required');
      }
      const adapted = buildOrchestrationRequest(input);
      const raw = await base.request<unknown>(adapted);
      try {
        return await unwrapOrchestrationResponse(raw, input.parse);
      } catch (error) {
        throw registerProtocolErrorContext(error, adapted.body ?? '', raw);
      }
    },
  };
  return client;
}
