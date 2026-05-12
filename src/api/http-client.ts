declare const __VERSION__: string;
import { randomBytes, createHash } from 'crypto';
import type {
  ApiClient,
  ListModelsOptions,
  UsageSummaryOptions,
  UsageBreakdownOptions,
} from './client.js';
import type {
  Model,
  ModelsListResponse,
  ModelDetail,
  FreeTierQuota,
  ModalityType,
} from '../types/model.js';
import type {
  UsageSummaryResponse,
  UsageBreakdownResponse,
  FreeTierUsage,
  TokenPlan,
} from '../types/usage.js';
import type { AuthStatus, DeviceFlowInitResponse, DeviceFlowPollResponse } from '../types/auth.js';
import { loginCommand } from '../utils/runtime-mode.js';
import type {
  ApiModelsListResponse,
  ApiModelItem,
  FqInstanceResponse,
  FrInstanceResponse,
  ConsumeSummaryLineItem,
} from '../types/api-models.js';
import {
  mapApiModelToModel,
  mapApiModelToModelDetail,
  flattenApiModels,
  mapFqInstanceToQuota,
} from './model-mapper.js';
import { getGlobalCache, CacheKeys, CacheTTL } from '../utils/cache.js';
import { normalizeForSearch } from '../utils/search-normalize.js';
import { getEffectiveConfig } from '../config/manager.js';
import { getOrCreateClientId } from '../auth/client-id.js';
import { site } from '../site.js';
import {
  resolveCredentials,
  isTokenExpired,
  tryExtractUserFromToken,
} from '../auth/credentials.js';

import { startRequest, endRequest, addDiagnostic, isEnabled } from './debug-buffer.js';
import {
  aggregatePaygByModel,
  aggregatePaygByDate,
  fillDailyGaps,
  type PaygItem,
} from './payg-aggregator.js';
import { classifyHttpError } from '../utils/api-errors.js';

// Real API configuration
function getApiBaseUrl(): string {
  const endpoint = getEffectiveConfig()['api.endpoint'].replace(/\/+$/, '');
  return `${endpoint}/data/v2/api.json`;
}
const API_PRODUCT = 'AliyunDeliveryService';
const API_ACTION_LIST_MODELS = 'ListModelSeries';
const DEFAULT_REGION = 'cn-beijing';
const DEFAULT_LANGUAGE = 'en-US';
const MODEL_MAPPING_URL = site.features.cdnBaseUrl;
const API_PRODUCT_BSS = 'BssOpenAPI-V3';
const API_ACTION_DESCRIBE_FQ = 'DescribeFqInstance';
const API_ACTION_DESCRIBE_FR = 'DescribeFrInstances';

function getAuthHeaders(): Record<string, string> {
  const resolved = resolveCredentials();
  if (!resolved) {
    throw classifyHttpError(new Error(`Not authenticated. Please login first:\n\n  ${loginCommand()}`));
  }
  return { Authorization: `Bearer ${resolved.access_token}` };
}

/**
 * Production HTTP API client.
 * Implements all ApiClient methods via real HTTP calls to QianWen backend.
 */
export class HttpApiClient implements ApiClient {
  private cache = getGlobalCache();
  private latestQuotaMap: Map<string, FreeTierQuota | null> = new Map();

  /**
   * Generic HTTP request method.
   * Responsible only for: sending the HTTP request, handling the response
   * status code, and returning the JSON result.
   */
  private async request<T>(options: {
    url: string;
    method?: string;
    headers?: HeadersInit;
    body?: string;
    context?: string;
  }): Promise<T> {
    const { url, method = 'POST', headers = {}, body, context = 'api' } = options;

    // Single call to getAuthHeaders() — avoid double invocation and TOCTOU
    const authHeaders = getAuthHeaders();
    const requestHeaders: Record<string, string> = {
      'User-Agent': `${site.userAgentPrefix}/${typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0'}`,
      ...(headers as Record<string, string>),
      ...authHeaders,
    };

    // Redact Authorization header before passing to debug buffer
    const debugHeaders: Record<string, unknown> = { ...requestHeaders };
    if (typeof debugHeaders['Authorization'] === 'string') {
      const token = debugHeaders['Authorization'];
      debugHeaders['Authorization'] =
        token.length > 12 ? `${token.slice(0, 7)}****${token.slice(-4)}` : '****';
    }
    const debugId = isEnabled()
      ? startRequest(method, url, debugHeaders, body ?? null, context)
      : -1;

    let response: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        ...(body !== undefined && { body }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      // Network-level failure (DNS, timeout, connection refused, etc.)
      if (debugId >= 0) endRequest(debugId, null, 'NetworkError', null, true);
      throw classifyHttpError(err, url);
    }

    if (!response.ok) {
      // Try to read response body for server-side error details
      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch {
        // ignore body read failure
      }
      if (debugId >= 0)
        endRequest(debugId, response.status, response.statusText, responseBody, true);
      const detailParts = [`HTTP ${response.status}: ${response.statusText}`, `  URL: ${url}`];
      if (responseBody) {
        // Truncate overly long bodies
        const truncated =
          responseBody.length > 500 ? responseBody.slice(0, 500) + '...(truncated)' : responseBody;
        detailParts.push(`  Response: ${truncated}`);
      }
      throw classifyHttpError(new Error(detailParts.join('\n')), url);
    }

    if (debugId >= 0) {
      const cloned = response.clone();
      const text = await cloned.text();
      endRequest(debugId, response.status, response.statusText, text, false);
    }

    return response.json();
  }

  /**
   * Build the API request configuration (JSON body).
   */
  private buildApiRequest(
    action: string,
    params: Record<string, unknown> = {},
    product?: string,
  ): {
    url: string;
    headers: HeadersInit;
    body: string;
  } {
    const payload: Record<string, unknown> = {
      product: product || API_PRODUCT,
      action,
      region: DEFAULT_REGION,
    };

    if (params && Object.keys(params).length > 0) {
      payload.params = this.flattenParams(params);
    }

    return {
      url: getApiBaseUrl(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }

  /**
   * Get the model mapping (model-id -> templateCode).
   * Used to determine whether a model has a FreeTier.
   */
  private async fetchModelMapping(): Promise<Record<string, string>> {
    const cached = this.cache.get<Record<string, string>>(CacheKeys.MODEL_MAPPING);
    if (cached) return cached;

    try {
      const debugId = isEnabled()
        ? startRequest('GET', MODEL_MAPPING_URL, {}, null, 'modelMapping')
        : -1;
      const mapController = new AbortController();
      const mapTimeoutId = setTimeout(() => mapController.abort(), 30_000);
      const response = await fetch(MODEL_MAPPING_URL, {
        signal: mapController.signal,
        headers: {
          'User-Agent': `${site.userAgentPrefix}/${typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0'}`,
        },
      });
      clearTimeout(mapTimeoutId);
      if (debugId >= 0)
        endRequest(debugId, response.status, response.statusText, null, !response.ok);
      if (!response.ok) {
        throw new Error(`Failed to fetch model mapping: ${response.status}`);
      }
      const mapping: Record<string, string> = await response.json();
      this.cache.set(CacheKeys.MODEL_MAPPING, mapping, CacheTTL.MODEL_MAPPING);
      return mapping;
    } catch (error) {
      addDiagnostic(
        'FreeTier',
        `Failed to load model mapping: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return {};
    }
  }

  /**
   * Batch-query FreeTier quotas.
   */
  private async fetchFreeTierQuotas(templateCodes: string[]): Promise<Map<string, FreeTierQuota>> {
    const quotaMap = new Map<string, FreeTierQuota>();
    if (templateCodes.length === 0) return quotaMap;

    try {
      const { url, headers, body } = this.buildApiRequest(
        API_ACTION_DESCRIBE_FQ,
        { templateCodes, PageSize: 500 },
        API_PRODUCT_BSS,
      );

      const result = await this.request<{
        code?: string;
        data?: FqInstanceResponse;
        message?: string;
      }>({
        url,
        method: 'POST',
        headers,
        body,
        context: 'freeTierQuotas',
      });

      // 1. Genuine API error
      if (String(result.code) !== '200') {
        addDiagnostic(
          'FreeTier',
          `DescribeFqInstance API error - code: ${result.code}, message: ${result.message || 'unknown'}`,
          'warn',
        );
        return quotaMap;
      }

      // 2. API succeeded but returned no data (user has no FreeTier or model is in Early Access) — silently return empty map
      if (!result.data?.Data) {
        return quotaMap;
      }

      const fqData: FqInstanceResponse = result.data;

      // Debug log: print returned instance details (only when no valid instance matched)
      let hasMatchedInstance = false;

      for (const instance of fqData.Data) {
        // Valid statuses: valid (active), exhaust (used up), expire (period expired)
        // exhaust/expire states still need quota info for semantic display
        const isValidStatus =
          instance.Status === 'valid' ||
          instance.Status === 'exhaust' ||
          instance.Status === 'expire';
        if (isValidStatus && instance.Template?.Code) {
          const quota = mapFqInstanceToQuota(instance);
          quotaMap.set(instance.Template.Code, quota);
          hasMatchedInstance = true;
        }
      }

      // Emit debug info only when there is data but no valid instance matched
      if (!hasMatchedInstance && fqData.Data.length > 0) {
        const details = fqData.Data.map(
          (instance, idx) =>
            `  [${idx}] Status: "${instance.Status}" (valid/exhaust/expire required), Template.Code: "${instance.Template?.Code || '(missing)'}"`,
        ).join('\n');
        addDiagnostic(
          'FreeTier',
          `Parsed ${fqData.Data.length} instances but none matched:\n${details}`,
        );
      }
    } catch (error) {
      addDiagnostic(
        'FreeTier',
        `fetchFreeTierQuotas failed: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }

    return quotaMap;
  }

  /**
   * List models.
   *
   * Caching strategy:
   * - Raw model data (MODELS_RAW_LIST): cached for 10 minutes (changes slowly)
   * - model-mapping: cached for 10 minutes
   * - FreeTier quota: not queried here; deferred to the presentation layer and
   *   fetched on-demand per page.
   *
   * Per-call flow:
   * 1. Read raw model data from cache (hit -> skip API request).
   * 2. Mark free_tier.mode (from model-mapping; low cost).
   * 3. quota is uniformly set to null and filled in on-demand by
   *    fetchQuotasForModels().
   */
  async listModels(options?: ListModelsOptions): Promise<ModelsListResponse> {
    const cache = this.cache;

    // 1. Get raw model data (cacheable)
    let rawItems = cache.get<ApiModelItem[]>(CacheKeys.MODELS_RAW_LIST);
    let mapping: Record<string, string>;

    if (!rawItems) {
      // Cache miss: request model list + model-mapping in parallel
      const fetchedMapping = await this.fetchModelMapping();
      mapping = fetchedMapping;

      const requestConfig = this.buildApiRequest(API_ACTION_LIST_MODELS, {
        Language: DEFAULT_LANGUAGE,
      });
      const rawResponse = await this.request<ApiModelsListResponse>(requestConfig);

      if (String(rawResponse.code) !== '200') {
        throw new Error(`API error: ${rawResponse.message || 'Unknown error'}`);
      }

      rawItems = flattenApiModels(rawResponse.data.Data);

      // Cache the raw model data (without quotas)
      cache.set(CacheKeys.MODELS_RAW_LIST, rawItems, CacheTTL.MODELS_LIST);
    } else {
      // Cache hit; still need to fetch mapping (which has its own cache)
      mapping = await this.fetchModelMapping();
    }

    // 2. Build the model list (only mark free_tier.mode; do not query quotas).
    //    Quota queries are deferred to the presentation layer and issued
    //    on-demand for the current page.
    const models = rawItems.map((item) => {
      const templateCode = mapping[item.Model];
      const hasFreeTier = !!templateCode;
      // quota is uniformly set to null and filled in on-demand by fetchQuotasForModels
      return mapApiModelToModel(item, hasFreeTier, null);
    });

    const result: ModelsListResponse = {
      models,
      total: models.length,
    };

    return this.filterModels(result, options);
  }

  /**
   * Filter the model list.
   */
  private filterModels(
    result: ModelsListResponse,
    options?: ListModelsOptions,
  ): ModelsListResponse {
    let models = result.models;

    if (options?.input) {
      const inputModalities = options.input
        .split(',')
        .map((m) => m.trim().toLowerCase() as ModalityType);
      models = models.filter((m) =>
        inputModalities.every((modality) => m.modality.input.includes(modality)),
      );
    }

    if (options?.output) {
      const outputModalities = options.output
        .split(',')
        .map((m) => m.trim().toLowerCase() as ModalityType);
      models = models.filter((m) =>
        outputModalities.every((modality) => m.modality.output.includes(modality)),
      );
    }

    return {
      models,
      total: models.length,
    };
  }

  /**
   * Get a model's detail.
   * Raw model data is cacheable; FreeTier quotas are queried in real time.
   */
  async getModel(id: string): Promise<ModelDetail> {
    // 1. Get raw model data (cacheable)
    let rawItems = this.cache.get<ApiModelItem[]>(CacheKeys.MODELS_RAW_LIST);
    if (!rawItems) {
      // Cache miss: trigger listModels to populate the raw-data cache
      await this.listModels();
      rawItems = this.cache.get<ApiModelItem[]>(CacheKeys.MODELS_RAW_LIST);
    }

    if (!rawItems) {
      throw new Error(`Failed to load model data`);
    }

    // 2. Look up the matching model in the raw data
    const apiItem = rawItems.find((item) => item.Model === id);
    if (!apiItem) {
      throw new Error(`Model '${id}' not found`);
    }

    // 3. Get mapping (which has its own cache)
    const mapping = await this.fetchModelMapping();
    const templateCode = mapping[apiItem.Model];
    const hasFreeTier = !!templateCode;

    // 4. Query the FreeTier quota (prefer the existing quota cache)
    let quota: FreeTierQuota | null = null;
    if (templateCode) {
      if (this.latestQuotaMap.has(templateCode)) {
        // Already queried (may be null, meaning no quota)
        quota = this.latestQuotaMap.get(templateCode) ?? null;
      } else {
        // Not yet queried — issue a query
        const quotaMap = await this.fetchFreeTierQuotas([templateCode]);
        quota = quotaMap.get(templateCode) || null;
        this.latestQuotaMap.set(templateCode, quota);
      }
    }

    // 5. Convert to ModelDetail (not cached because it includes a live quota)
    return mapApiModelToModelDetail(apiItem, hasFreeTier, quota);
  }

  /**
   * Batch-fetch FreeTier quotas for a set of models (on-demand).
   *
   * Used by the presentation layer to query quotas for the current page only,
   * rather than fetching everything:
   * - Extract models with free_tier.mode === 'standard'.
   * - Get their templateCodes via model-mapping.
   * - Call DescribeFqInstance only for those models.
   * - Return the model array with quotas filled in.
   *
   * Degradation: if the quota query fails, leave quota as null (the
   * presentation layer will display "Yes").
   */
  async fetchQuotasForModels(models: Model[]): Promise<Model[]> {
    // Filter models that have a FreeTier
    const freeTierModels = models.filter((m) => m.free_tier.mode === 'standard');
    if (freeTierModels.length === 0) return models;

    // Get mapping
    const mapping = await this.fetchModelMapping();

    // Extract templateCodes
    const codeToModelIds = new Map<string, string[]>();
    for (const m of freeTierModels) {
      const code = mapping[m.id];
      if (code) {
        const ids = codeToModelIds.get(code) || [];
        ids.push(m.id);
        codeToModelIds.set(code, ids);
      }
    }

    if (codeToModelIds.size === 0) return models;

    // Query quotas
    const quotaMap = await this.fetchFreeTierQuotas([...codeToModelIds.keys()]);
    // Write all queried templateCodes to the cache; store null when no quota to avoid cache penetration
    for (const code of codeToModelIds.keys()) {
      const quota = quotaMap.get(code) ?? null;
      this.latestQuotaMap.set(code, quota);
    }

    // Build modelId -> quota mapping
    const modelQuotaMap = new Map<string, FreeTierQuota>();
    for (const [code, ids] of codeToModelIds) {
      const quota = quotaMap.get(code);
      if (quota) {
        for (const id of ids) {
          modelQuotaMap.set(id, quota);
        }
      }
    }

    // Return the model array with quotas filled in
    return models.map((m) => {
      const quota = modelQuotaMap.get(m.id);
      if (quota) {
        return { ...m, free_tier: { ...m.free_tier, quota } };
      }
      return m;
    });
  }

  /**
   * Batch-fetch model details.
   * Query FreeTier quotas for all models at once to avoid per-model queries.
   * The return order matches the input ids; null is returned for ids that
   * cannot be resolved.
   */
  async getModels(ids: string[]): Promise<(ModelDetail | null)[]> {
    if (ids.length === 0) return [];

    // 1. Ensure raw model data has been loaded
    let rawItems = this.cache.get<ApiModelItem[]>(CacheKeys.MODELS_RAW_LIST);
    if (!rawItems) {
      await this.listModels();
      rawItems = this.cache.get<ApiModelItem[]>(CacheKeys.MODELS_RAW_LIST);
    }
    if (!rawItems) {
      return ids.map(() => null);
    }

    // 2. Get model-mapping
    const mapping = await this.fetchModelMapping();

    // 3. Look up each id's ApiModelItem and collect all templateCodes
    const itemMap = new Map<string, ApiModelItem>();
    for (const item of rawItems) {
      itemMap.set(item.Model, item);
    }

    const templateCodes: string[] = [];
    const templateCodeSet = new Set<string>();
    for (const id of ids) {
      const apiItem = itemMap.get(id);
      if (apiItem) {
        const code = mapping[apiItem.Model];
        if (code && !templateCodeSet.has(code) && !this.latestQuotaMap.has(code)) {
          templateCodes.push(code);
          templateCodeSet.add(code);
        }
      }
    }

    // 4. Batch-query all uncached quotas in a single request
    if (templateCodes.length > 0) {
      const quotaMap = await this.fetchFreeTierQuotas(templateCodes);
      // Mark all queried templateCodes in the cache to avoid cache penetration.
      // For models without a quota, store null as a placeholder to prevent repeated queries.
      for (const code of templateCodes) {
        const quota = quotaMap.get(code);
        if (quota) {
          this.latestQuotaMap.set(code, quota);
        } else {
          // Mark as queried-but-no-quota; store null to prevent repeated queries
          this.latestQuotaMap.set(code, null);
        }
      }
    }

    // 5. Batch-map to ModelDetail[]
    return ids.map((id) => {
      const apiItem = itemMap.get(id);
      if (!apiItem) return null;

      const templateCode = mapping[apiItem.Model];
      const hasFreeTier = !!templateCode;
      const quota = templateCode ? (this.latestQuotaMap.get(templateCode) ?? null) : null;
      return mapApiModelToModelDetail(apiItem, hasFreeTier, quota);
    });
  }

  /**
   * Search models.
   */
  async searchModels(keyword: string): Promise<ModelsListResponse> {
    const listResponse = await this.listModels();
    // Normalize the keyword and every candidate field so "function calling"
    // (with a space) matches a feature like "function-calling" (with a hyphen).
    const needle = normalizeForSearch(keyword);
    const matches = (haystack: string | undefined): boolean =>
      !!haystack && normalizeForSearch(haystack).includes(needle);

    // Use cached raw API data for richer search (description, tags, features)
    const rawItems = this.cache.get<ApiModelItem[]>(CacheKeys.MODELS_RAW_LIST);
    const rawIndex = new Map<string, ApiModelItem>();
    if (rawItems) {
      for (const item of rawItems) {
        rawIndex.set(item.Model, item);
      }
    }

    const filtered = listResponse.models.filter((model) => {
      if (matches(model.id)) return true;
      if (model.modality.input.some((m) => matches(m))) return true;
      if (model.modality.output.some((m) => matches(m))) return true;

      const raw = rawIndex.get(model.id);
      if (raw) {
        if (matches(raw.Description)) return true;
        if (matches(raw.ShortDescription)) return true;
        if (raw.Tags?.some((t) => matches(t))) return true;
        if (raw.Features?.some((f) => matches(f))) return true;
        if (raw.Capabilities?.some((c) => matches(c))) return true;
      }

      return false;
    });

    return {
      models: filtered,
      total: filtered.length,
    };
  }

  // ============================================================
  // Usage API — real implementation
  // ============================================================

  // --- Free Tier (DescribeFqInstance) ---
  // Already implemented in fetchFreeTierQuotas(); reuse here.

  // --- Data gateway (IntlBroadScopeAspnGateway) ---
  private API_PRODUCT_SFM = 'sfm_bailian';
  private API_ACTION_GATEWAY = 'IntlBroadScopeAspnGateway';

  /**
   * Call the data analytics gateway (IntlBroadScopeAspnGateway).
   */
  private async requestDataGateway(
    apiPath: string,
    dataPayload?: Record<string, unknown>,
  ): Promise<unknown> {
    const baseUrl = getEffectiveConfig()['api.endpoint'].replace(/\/+$/, '');
    const url = `${baseUrl}/data/v2/api.json`;

    const genericPayload: Record<string, unknown> = {
      product: this.API_PRODUCT_SFM,
      action: this.API_ACTION_GATEWAY,
      region: DEFAULT_REGION,
      api: apiPath,
    };
    if (dataPayload) {
      genericPayload['Data'] = dataPayload;
    }

    return await this.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(genericPayload),
    });
  }

  // --- Pay-as-you-go (MaasListConsumeSummary) ---
  private API_ACTION_CONSUME_SUMMARY = 'MaasListConsumeSummary';

  // Categories to skip (not model usage)
  private SKIP_LINE_ITEM_CATEGORIES = new Set([
    'Rounding Adjustment',
    'Refund',
    'Credit Adjustment',
  ]);

  /**
   * Infer billing_unit from BillingItemCode and StepQuantityUnit.
   */
  private inferBillingUnit(stepUnit: string, billingItemCode: string = ''): string {
    const code = billingItemCode.toLowerCase();
    if (code.includes('image')) return 'images';
    if (code.includes('video') || code.includes('duration')) return 'seconds';
    if (code.includes('char')) return 'characters';
    if (code.includes('token')) return 'tokens';

    const unitLower = stepUnit.toLowerCase();
    if (unitLower.includes('token')) return 'tokens';
    if (unitLower.includes('image') || unitLower.includes('page')) return 'images';
    if (unitLower.includes('second') || unitLower.includes('sec')) return 'seconds';
    if (unitLower.includes('char') || unitLower.includes('word')) return 'characters';
    return 'tokens';
  }

  /**
   * Convert BillQuantity × StepQuantityUnit step size to raw units.
   * e.g. "1K tokens" → ×1000, "1M tokens" → ×1_000_000
   */
  private computeUsageValue(billQuantity: number, stepUnit: string): number {
    const unitLower = stepUnit.toLowerCase();
    // "tenthousand word" style units: treat as ×10000
    if (unitLower.includes('tenthousand') || unitLower === '\u4e07\u5b57') {
      return billQuantity * 10000;
    }
    const match = stepUnit.trim().match(/(\d+(?:\.\d+)?)\s*([kmKM]?)/);
    if (match) {
      let multiplier = parseFloat(match[1]);
      const suffix = match[2].toUpperCase();
      if (suffix === 'K') multiplier *= 1000;
      else if (suffix === 'M') multiplier *= 1_000_000;
      return billQuantity * multiplier;
    }
    return billQuantity;
  }

  /**
   * Flatten params dict so every value is a string (Map<String, String>).
   * Scalars → str, dicts/lists → JSON string.
   */
  private flattenParams(params: Record<string, unknown>): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string') {
        flat[k] = v;
      } else if (typeof v === 'boolean') {
        flat[k] = JSON.stringify(v);
      } else if (typeof v === 'number') {
        flat[k] = String(v);
      } else if (typeof v === 'object') {
        flat[k] = JSON.stringify(v);
      } else {
        flat[k] = String(v);
      }
    }
    return flat;
  }

  /**
   * Parse a single MaasListConsumeSummary line item.
   * Returns null for items that should be skipped.
   */
  private parseBillingItem(
    item: ConsumeSummaryLineItem,
    costMode: 'full' | 'minimal' = 'full',
  ): {
    lineItemCat: string;
    billingDate: string;
    billingMonth: string;
    modelId: string;
    usageValue: number;
    cost: number;
    billingUnit: string;
    isFree: boolean;
  } | null {
    const lineItemCat = item.LineItemCategory ?? '';
    if (this.SKIP_LINE_ITEM_CATEGORIES.has(lineItemCat)) {
      return null;
    }

    const isFree = lineItemCat.includes('Free');

    const billQuantity = Number(item.BillQuantity ?? 0);
    const stepUnit = item.StepQuantityUnit ?? '';
    const billingItemCode = item.BillingItemCode ?? '';
    const billingUnit = this.inferBillingUnit(stepUnit, billingItemCode);
    const usageValue = stepUnit ? this.computeUsageValue(billQuantity, stepUnit) : billQuantity;

    let cost: number;
    if (costMode === 'minimal') {
      cost = Number(item.RequireAmount ?? item.ListPrice ?? 0);
    } else {
      cost = Number(item.RequireAmount ?? item.Amount ?? item.Cost ?? item.ListPrice ?? 0);
    }

    const billingDate = item.BillingDate ?? '';
    const billingMonth = item.BillingMonth ?? (billingDate ? billingDate.slice(0, 7) : '');
    const modelId = item.ModelName ?? item.Model ?? '';

    return {
      lineItemCat,
      billingDate,
      billingMonth,
      modelId,
      usageValue,
      cost,
      billingUnit,
      isFree,
    };
  }

  /**
   * Split a date range into per-calendar-month sub-ranges.
   * The API requires each call to stay within a single calendar month.
   */
  private splitIntoMonths(fromDate: string, toDate: string): Array<[string, string]> {
    const ranges: Array<[string, string]> = [];
    let cur = new Date(fromDate + 'T00:00:00Z');
    const end = new Date(toDate + 'T00:00:00Z');

    while (cur <= end) {
      // Last day of cur's month
      const monthEnd = new Date(cur);
      monthEnd.setMonth(monthEnd.getMonth() + 1, 0); // day 0 = last day of previous month

      const rangeEnd = monthEnd <= end ? monthEnd : end;
      ranges.push([cur.toISOString().split('T')[0], rangeEnd.toISOString().split('T')[0]]);

      // Advance to first day of next month
      cur = new Date(monthEnd);
      cur.setDate(cur.getDate() + 1);
    }

    return ranges;
  }

  /**
   * Fetch Free Tier quota list (using the already-existing DescribeFqInstance infra).
   * Maps template codes to model names via model-mapping.
   */
  private async fetchFreeTierUsageList(): Promise<FreeTierUsage[]> {
    // Get model-mapping and template codes
    const mapping = await this.fetchModelMapping();
    const templateCodes = Object.values(mapping);
    if (templateCodes.length === 0) return [];

    // Use existing quota fetching infrastructure
    const quotaMap = await this.fetchFreeTierQuotas(templateCodes);

    // Build reverse mapping: templateCode → model IDs
    const codeToModelIds = new Map<string, string[]>();
    for (const [modelId, code] of Object.entries(mapping)) {
      const ids = codeToModelIds.get(code) || [];
      ids.push(modelId);
      codeToModelIds.set(code, ids);
    }

    const freeTierList: FreeTierUsage[] = [];
    for (const [code, ids] of codeToModelIds) {
      const quota = quotaMap.get(code);
      for (const modelId of ids) {
        freeTierList.push({
          model_id: modelId,
          quota: quota
            ? {
                remaining: quota.remaining,
                total: quota.total,
                unit: quota.unit,
                used_pct: quota.used_pct,
                status: quota.status,
                resetDate: quota.resetDate ?? null,
              }
            : null,
        });
      }
    }

    return freeTierList;
  }

  // --- Token Plan (DescribeFrInstances) ---

  /**
   * Fetch Token Plan subscription info via DescribeFrInstances.
   * Queries team/personal plans and add-on packages in parallel.
   * Returns { subscribed: false } when the feature is disabled or no valid instance found.
   */
  private async fetchTokenPlan(): Promise<TokenPlan> {
    if (!site.features.enableTokenPlan) {
      return { subscribed: false };
    }

    const codes = site.features.tokenPlanCommodityCodes;

    try {
      const [teamsRes, personalRes, addonRes] = await Promise.all([
        this.fetchFrInstances(codes.teams, 10),
        this.fetchFrInstances(codes.personal, 10),
        this.fetchFrInstances(codes.addon, 100),
      ]);

      // Merge team + personal: pick first valid instance, team first
      const allPlanInstances = [...(teamsRes?.Data ?? []), ...(personalRes?.Data ?? [])];
      const validInstance = allPlanInstances.find((inst) => {
        const statusCode = typeof inst.Status === 'object' ? inst.Status?.Code : inst.Status;
        return statusCode === 'valid';
      }) ?? allPlanInstances[0]; // fallback to first if none is valid

      // Compute addon remaining credits (sum of all addon CurrCapacityBaseValue)
      const addonRemaining = (addonRes?.Data ?? []).reduce((sum, inst) => {
        return sum + Number(inst.CurrCapacityBaseValue || 0);
      }, 0);

      if (!validInstance) {
        // No plan instances at all
        if (addonRemaining > 0) {
          // User has addons but no active plan — still show addon credits
          return { subscribed: false, addonRemaining };
        }
        return { subscribed: false };
      }

      const statusCode = typeof validInstance.Status === 'object' ? validInstance.Status?.Code : validInstance.Status;
      const totalCredits = Number(validInstance.InitCapacityBaseValue || 0);
      // Use periodCapacityBaseValue when CapacityTypeCode is periodMonthlyShift
      const capacityType = validInstance.CapacityTypeCode ?? '';
      const remainingCredits = capacityType === 'periodMonthlyShift'
        ? Number(validInstance.periodCapacityBaseValue || validInstance.CurrCapacityBaseValue || 0)
        : Number(validInstance.CurrCapacityBaseValue || 0);
      const usedPct = totalCredits > 0 ? Math.round(((totalCredits - remainingCredits) / totalCredits) * 100) : 0;
      const resetDate = validInstance.EndTime ? new Date(validInstance.EndTime).toISOString() : undefined;

      return {
        subscribed: statusCode === 'valid',
        planName: validInstance.TemplateName ?? validInstance.CommodityName,
        status: statusCode as TokenPlan['status'],
        totalCredits,
        remainingCredits,
        usedPct,
        resetDate,
        addonRemaining: addonRemaining > 0 ? addonRemaining : undefined,
      };
    } catch (error) {
      addDiagnostic(
        'TokenPlan',
        `fetch failed, treating as not subscribed: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return { subscribed: false };
    }
  }

  /**
   * Call DescribeFrInstances for a specific commodity code.
   */
  private async fetchFrInstances(
    commodityCode: string,
    pageSize: number,
  ): Promise<FrInstanceResponse | null> {
    const { url, headers, body } = this.buildApiRequest(
      API_ACTION_DESCRIBE_FR,
      { Group: 'tokenPlan', CommodityCode: commodityCode, PageNum: 1, PageSize: pageSize },
      API_PRODUCT_BSS,
    );

    const result = await this.request<{
      code?: string;
      data?: FrInstanceResponse;
      message?: string;
    }>({
      url,
      method: 'POST',
      headers,
      body,
      context: 'tokenPlan',
    });

    if (String(result.code) !== '200') {
      addDiagnostic(
        'TokenPlan',
        `DescribeFrInstances API error - code: ${result.code}, message: ${result.message || 'unknown'}`,
        'warn',
      );
      return null;
    }

    return result.data ?? null;
  }

  /**
   * Fetch raw pay-as-you-go billing items for a date range. Single source of
   * truth for both summary and breakdown — both views reduce the result with
   * pure aggregators (`payg-aggregator.ts`).
   *
   * Always queries with `DAILY` granularity (the breakdown command aggregates
   * monthly/quarterly client-side from daily rows). `modelFilter`, when given,
   * narrows the upstream query via `ModelNames`.
   */
  private async fetchPaygItems(
    fromDate: string,
    toDate: string,
    modelFilter?: string,
  ): Promise<PaygItem[]> {
    const collected: PaygItem[] = [];

    for (const [monthStart, monthEnd] of this.splitIntoMonths(fromDate, toDate)) {
      const params: Record<string, unknown> = {
        Console: true,
        Granularity: 'DAILY',
        ChargeTypes: ['postpaid'],
        StartBillingDate: monthStart,
        EndBillingDate: monthEnd,
        MaxResults: 100,
        CurrentPage: 1,
        SortName: 'BillingDate',
        SortOrder: 'DESC',
      };
      if (modelFilter) params['ModelNames'] = [modelFilter];

      const { url, headers, body } = this.buildApiRequest(
        this.API_ACTION_CONSUME_SUMMARY,
        params,
        API_PRODUCT_BSS,
      );

      const response = await this.request<{
        code?: string;
        data?: { Data?: ConsumeSummaryLineItem[] };
        message?: string;
      }>({
        url,
        method: 'POST',
        headers,
        body,
      });

      if (String(response.code) !== '200') {
        addDiagnostic(
          'PAYG',
          `MaasListConsumeSummary error: code=${response.code}, message=${response.message || 'unknown'}`,
        );
        continue;
      }

      for (const item of response.data?.Data ?? []) {
        const parsed = this.parseBillingItem(item, 'full');
        if (!parsed || parsed.isFree) continue;
        collected.push({
          billingDate: parsed.billingDate,
          billingMonth: parsed.billingMonth,
          modelId: parsed.modelId,
          usageValue: parsed.usageValue,
          cost: parsed.cost,
          billingUnit: parsed.billingUnit,
        });
      }
    }

    return collected;
  }

  /**
   * Aggregate monthly rows into quarterly periods (client-side).
   */
  private aggregateQuarterly(
    monthlyRows: Array<{
      period: string;
      tokens_in?: number;
      cost: number;
      currency: string;
      billingUnit: string;
    }>,
  ): Array<{
    period: string;
    tokens_in?: number;
    tokens_out?: number;
    cost: number;
    currency: string;
    billingUnit: string;
  }> {
    const byQuarter: Record<
      string,
      {
        tokens_in: number;
        images: number;
        seconds: number;
        characters: number;
        cost: number;
        units: Set<string>;
      }
    > = {};

    for (const row of monthlyRows) {
      const monthStr = row.period;
      const year = parseInt(monthStr.slice(0, 4));
      const monthNum = parseInt(monthStr.slice(5, 7));
      const quarter = Math.floor((monthNum - 1) / 3) + 1;
      const quarterKey = `${year}-Q${quarter}`;

      if (!byQuarter[quarterKey]) {
        byQuarter[quarterKey] = {
          tokens_in: 0,
          images: 0,
          seconds: 0,
          characters: 0,
          cost: 0,
          units: new Set(),
        };
      }

      const q = byQuarter[quarterKey];
      q.cost += row.cost;
      if (row.tokens_in) {
        q.tokens_in += row.tokens_in;
        q.units.add('tokens');
      }
      // Handle other unit fields from the row
      if ('tokens_out' in row && row.tokens_out) {
        q.units.add('tokens');
      }
      if ('images' in row) {
        q.images += (row as Record<string, number>).images ?? 0;
        q.units.add('images');
      }
      if ('seconds' in row) {
        q.seconds += (row as Record<string, number>).seconds ?? 0;
        q.units.add('seconds');
      }
      if ('characters' in row) {
        q.characters += (row as Record<string, number>).characters ?? 0;
        q.units.add('characters');
      }
    }

    // Build output rows
    const rows: Array<{
      period: string;
      tokens_in?: number;
      tokens_out?: number;
      cost: number;
      currency: string;
      billingUnit: string;
    }> = [];

    for (const [key, q] of Object.entries(byQuarter).sort(([a], [b]) => a.localeCompare(b))) {
      const usage: Record<string, number> = {};
      if (q.tokens_in) usage['tokens_in'] = q.tokens_in;
      if (q.images) usage['images'] = q.images;
      if (q.seconds) usage['seconds'] = q.seconds;
      if (q.characters) usage['characters'] = q.characters;

      const unitsList = [...q.units].sort();
      const billingUnit = unitsList.length === 1 ? unitsList[0] : 'tokens';

      rows.push({
        period: key,
        ...usage,
        cost: Math.round(q.cost * 10000) / 10000,
        currency: site.features.currency,
        billingUnit,
      });
    }

    return rows;
  }

  /**
   * Aggregate daily rows into monthly rows client-side.
   * Used so that monthly/quarterly totals are consistent with the daily view.
   */
  private aggregateMonthly(
    dailyRows: Array<{
      period: string;
      tokens_in?: number;
      tokens_out?: number;
      cost: number;
      currency: string;
      billingUnit: string;
    }>,
  ): Array<{
    period: string;
    tokens_in?: number;
    tokens_out?: number;
    cost: number;
    currency: string;
    billingUnit: string;
  }> {
    const byMonth: Record<
      string,
      {
        tokens_in: number;
        tokens_out: number;
        images: number;
        seconds: number;
        characters: number;
        cost: number;
        units: Set<string>;
      }
    > = {};

    for (const row of dailyRows) {
      const monthKey = row.period.slice(0, 7); // YYYY-MM
      if (!byMonth[monthKey]) {
        byMonth[monthKey] = {
          tokens_in: 0,
          tokens_out: 0,
          images: 0,
          seconds: 0,
          characters: 0,
          cost: 0,
          units: new Set(),
        };
      }
      const m = byMonth[monthKey];
      m.cost += row.cost;
      if (row.tokens_in) {
        m.tokens_in += row.tokens_in;
        m.units.add('tokens');
      }
      if (row.tokens_out) {
        m.tokens_out += row.tokens_out;
        m.units.add('tokens');
      }
      if ('images' in row) {
        m.images += (row as any).images ?? 0;
        m.units.add('images');
      }
      if ('seconds' in row) {
        m.seconds += (row as any).seconds ?? 0;
        m.units.add('seconds');
      }
      if ('characters' in row) {
        m.characters += (row as any).characters ?? 0;
        m.units.add('characters');
      }
    }

    const rows: Array<{
      period: string;
      tokens_in?: number;
      tokens_out?: number;
      cost: number;
      currency: string;
      billingUnit: string;
    }> = [];

    for (const [key, m] of Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b))) {
      const unitsList = [...m.units].sort();
      const billingUnit = unitsList.length === 1 ? unitsList[0] : 'tokens';
      const usage: Record<string, number> = {};
      if (m.tokens_in) usage['tokens_in'] = m.tokens_in;
      if (m.tokens_out) usage['tokens_out'] = m.tokens_out;
      if (m.images) usage['images'] = m.images;
      if (m.seconds) usage['seconds'] = m.seconds;
      if (m.characters) usage['characters'] = m.characters;
      rows.push({
        period: key,
        ...usage,
        cost: Math.round(m.cost * 10000) / 10000,
        currency: site.features.currency,
        billingUnit,
      });
    }

    return rows;
  }

  // ============================================================
  // Public Usage API methods
  // ============================================================

  async getUsageSummary(options?: UsageSummaryOptions): Promise<UsageSummaryResponse> {
    const fromDate =
      options?.from ??
      new Date()
        .toISOString()
        .split('T')[0]
        .replace(/-\d{2}$/, '-01');
    const toDate = options?.to ?? new Date().toISOString().split('T')[0];

    // Fetch all sections in parallel. PAYG: pull raw items once, then
    // aggregate by model in-memory (same upstream as the breakdown view).
    const [freeTier, tokenPlan, paygItems] = await Promise.all([
      this.fetchFreeTierUsageList(),
      this.fetchTokenPlan(),
      this.fetchPaygItems(fromDate, toDate),
    ]);
    const payg = aggregatePaygByModel(paygItems);

    return {
      period: { from: fromDate, to: toDate },
      free_tier: freeTier,
      token_plan: tokenPlan,
      pay_as_you_go: payg,
    };
  }

  async getUsageBreakdown(options: UsageBreakdownOptions): Promise<UsageBreakdownResponse> {
    const fromDate =
      options.from ??
      new Date()
        .toISOString()
        .split('T')[0]
        .replace(/-\d{2}$/, '-01');
    const toDate = options.to ?? new Date().toISOString().split('T')[0];
    const granularity = options.granularity ?? 'day';
    const modelFilter = options.model;

    let rows: Array<{
      period: string;
      tokens_in?: number;
      tokens_out?: number;
      cost?: number;
      currency?: string;
      billingUnit: string;
    }>;

    // Always pull daily-level items, then collapse to days, then optionally
    // aggregate client-side to month/quarter. Keeps totals
    // consistent across all granularities.
    const items = await this.fetchPaygItems(fromDate, toDate, modelFilter);
    const rawDailyRows = aggregatePaygByDate(items);
    // Fill missing dates so every day in the range has a row (even if zero).
    const dailyRows = fillDailyGaps(rawDailyRows, fromDate, toDate);

    if (granularity === 'quarter') {
      rows = this.aggregateQuarterly(this.aggregateMonthly(dailyRows));
    } else if (granularity === 'month') {
      rows = this.aggregateMonthly(dailyRows);
    } else {
      rows = dailyRows;
    }

    // Compute totals across ALL billing units. Daily rows carry non-token
    // units flat (images / seconds / characters); the monthly/quarterly
    // aggregators preserve that shape.
    const totalCost = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
    const totalTokensIn = rows.reduce((sum, r) => sum + (r.tokens_in ?? 0), 0);
    const totalTokensOut = rows.reduce((sum, r) => sum + ((r as any).tokens_out ?? 0), 0);
    const totalImages = rows.reduce((sum, r) => sum + ((r as any).images ?? 0), 0);
    const totalSeconds = rows.reduce((sum, r) => sum + ((r as any).seconds ?? 0), 0);
    const totalCharacters = rows.reduce((sum, r) => sum + ((r as any).characters ?? 0), 0);

    // Build breakdown rows: tokens stay at top level, non-token units nest in
    // `usage` to match the view-model contract.
    const breakdownRows: UsageBreakdownResponse['rows'] = rows.map((r) => {
      const out: UsageBreakdownResponse['rows'][number] = {
        period: r.period,
        cost: r.cost,
        currency: r.currency,
      };
      if (r.tokens_in != null) out.tokens_in = r.tokens_in;
      if (r.tokens_out != null) out.tokens_out = r.tokens_out;
      const usage: Record<string, number> = {};
      const ar = r as any;
      if (ar.images != null) usage.images = ar.images;
      if (ar.seconds != null) usage.seconds = ar.seconds;
      if (ar.characters != null) usage.characters = ar.characters;
      if (Object.keys(usage).length > 0) out.usage = usage;
      return out;
    });

    const total: UsageBreakdownResponse['total'] = {
      cost: Math.round(totalCost * 10000) / 10000,
      currency: site.features.currency,
    };
    if (totalTokensIn > 0) total.tokens_in = Math.round(totalTokensIn);
    if (totalTokensOut > 0) total.tokens_out = Math.round(totalTokensOut);
    const totalUsage: Record<string, number> = {};
    if (totalImages > 0) totalUsage.images = Math.round(totalImages);
    if (totalSeconds > 0) totalUsage.seconds = Math.round(totalSeconds);
    if (totalCharacters > 0) totalUsage.characters = Math.round(totalCharacters);
    if (Object.keys(totalUsage).length > 0) total.usage = totalUsage;

    return {
      model_id: modelFilter ?? 'all',
      period: { from: fromDate, to: toDate },
      granularity,
      rows: breakdownRows,
      total,
    };
  }

  async getAuthStatus(): Promise<AuthStatus> {
    // Resolve credentials from keychain or file
    const resolved = resolveCredentials();
    if (!resolved) {
      return { authenticated: false, server_verified: false };
    }

    // Check local token expiry
    if (resolved.credentials && isTokenExpired(resolved.credentials)) {
      return { authenticated: false, server_verified: false };
    }

    // Attempt server verification via /api/account/info.json
    const accessToken = resolved.credentials?.access_token ?? '';
    const config = getEffectiveConfig();
    const baseUrl = (config['api.endpoint'] as string).replace(/\/+$/, '');
    const url = `${baseUrl}/api/account/info.json`;

    const authStatusController = new AbortController();
    const authStatusTimeoutId = setTimeout(() => authStatusController.abort(), 30_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: authStatusController.signal,
      });
      clearTimeout(authStatusTimeoutId);

      if (!response.ok) {
        // Fallback chain: credentials → JWT claims
        let failUser = resolved.credentials?.user ?? { email: '', aliyunId: '' };
        if (!failUser.email?.trim() && !failUser.aliyunId?.trim()) {
          const jwtUser = tryExtractUserFromToken(accessToken);
          if (jwtUser) failUser = jwtUser;
        }
        return {
          authenticated: true,
          server_verified: false,
          auth_mode: resolved.auth_mode,
          source: resolved.source,
          warning: `Server verification failed (HTTP ${response.status})`,
          user: failUser,
          token: {
            expires_at: resolved.credentials?.expires_at ?? 'unknown',
            scopes: ['inference:read', 'usage:read', 'config:write'],
          },
        };
      }

      const json = (await response.json()) as { data?: { aliyunId?: string; email?: string } };
      const serverAliyunId = json.data?.aliyunId ?? '';
      const serverEmail = json.data?.email ?? '';

      // Build user info with fallback chain: server → credentials → JWT claims
      let userEmail = serverEmail || (resolved.credentials?.user?.email ?? '');
      let userAliyunId = serverAliyunId || (resolved.credentials?.user?.aliyunId ?? '');
      if (!userEmail.trim() && !userAliyunId.trim()) {
        const jwtUser = tryExtractUserFromToken(accessToken);
        if (jwtUser) {
          userEmail = jwtUser.email;
          userAliyunId = jwtUser.aliyunId;
        }
      }

      return {
        authenticated: true,
        server_verified: true,
        auth_mode: resolved.auth_mode,
        source: resolved.source,
        user: {
          email: userEmail,
          aliyunId: userAliyunId,
        },
        token: {
          expires_at: resolved.credentials?.expires_at ?? 'unknown',
          scopes: ['inference:read', 'usage:read', 'config:write'],
        },
      };
    } catch (err: unknown) {
      const causeMsg = err instanceof Error ? err.message : String(err);
      // Fallback chain: credentials → JWT claims
      let errUser = resolved.credentials?.user ?? { email: '', aliyunId: '' };
      if (!errUser.email?.trim() && !errUser.aliyunId?.trim()) {
        const jwtUser = tryExtractUserFromToken(accessToken);
        if (jwtUser) errUser = jwtUser;
      }
      return {
        authenticated: true,
        server_verified: false,
        auth_mode: resolved.auth_mode,
        source: resolved.source,
        warning: `Server unreachable: ${causeMsg}`,
        user: errUser,
        token: {
          expires_at: resolved.credentials?.expires_at ?? 'unknown',
          scopes: ['inference:read', 'usage:read', 'config:write'],
        },
      };
    }
  }

  /**
   * Auth-specific HTTP request method.
   * Does NOT include Cookie or Authorization headers.
   */
  private async authRequest<T>(url: string): Promise<T> {
    const debugId = isEnabled() ? startRequest('POST', url, {}, null, 'auth') : -1;

    let response: Response;
    const authController = new AbortController();
    const authTimeoutId = setTimeout(() => authController.abort(), 30_000);
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: authController.signal,
        headers: {
          'User-Agent': `${site.userAgentPrefix}/${typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0'}`,
        },
      });
      clearTimeout(authTimeoutId);
    } catch (err: unknown) {
      clearTimeout(authTimeoutId);
      if (debugId >= 0) endRequest(debugId, null, 'NetworkError', null, true);
      throw classifyHttpError(err, url);
    }

    if (!response.ok) {
      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch {
        // ignore body read failure
      }
      if (debugId >= 0)
        endRequest(debugId, response.status, response.statusText, responseBody, true);
      const detailParts = [`HTTP ${response.status}: ${response.statusText}`, `  URL: ${url}`];
      if (responseBody) {
        const truncated =
          responseBody.length > 500 ? responseBody.slice(0, 500) + '...(truncated)' : responseBody;
        detailParts.push(`  Response: ${truncated}`);
      }
      throw classifyHttpError(new Error(detailParts.join('\n')), url);
    }

    if (debugId >= 0) {
      endRequest(debugId, response.status, response.statusText, '(auth - body redacted)', false);
    }

    return response.json();
  }

  private getAuthBaseUrl(): string {
    return getEffectiveConfig()['auth.endpoint'].replace(/\/+$/, '');
  }

  /**
   * Generate PKCE code_verifier and code_challenge per RFC 7636.
   * - code_verifier: 64-char URL-safe random string (43-128 chars per spec)
   * - code_challenge: BASE64URL(SHA256(code_verifier)), no padding
   *
   * Can be disabled via `${envPrefix}_PKCE_DISABLED=1` env var.
   */
  private generatePkce(): { codeVerifier: string; codeChallenge: string } | null {
    if (process.env[`${site.envPrefix}_PKCE_DISABLED`] === '1') {
      return null;
    }

    // Generate code_verifier: 64 URL-safe chars (secrets.token_urlsafe equivalent)
    const verifierBytes = randomBytes(48); // 48 bytes → 64 base64url chars
    const codeVerifier = verifierBytes.toString('base64url');

    // Generate code_challenge: BASE64URL(SHA256(code_verifier))
    const hash = createHash('sha256').update(codeVerifier).digest();
    const codeChallenge = hash.toString('base64url');

    return { codeVerifier, codeChallenge };
  }

  // PKCE state stored between init and poll
  private pkceVerifier: string | null = null;

  /**
   * Inject an external PKCE code_verifier (e.g. restored from pending state).
   * Used by executeDeviceFlowComplete() when resuming a two-stage login.
   */
  setPkceVerifier(verifier: string): void {
    this.pkceVerifier = verifier;
  }

  async deviceFlowInit(): Promise<DeviceFlowInitResponse> {
    const clientId = getOrCreateClientId();
    const baseUrl = this.getAuthBaseUrl();

    // Build URL with optional PKCE parameters
    let url = `${baseUrl}/cli/device/code?client_id=${encodeURIComponent(clientId)}`;
    const pkce = this.generatePkce();
    if (pkce) {
      url += `&code_challenge=${encodeURIComponent(pkce.codeChallenge)}&code_challenge_method=S256`;
      this.pkceVerifier = pkce.codeVerifier;
    } else {
      this.pkceVerifier = null;
    }

    interface RawInitResponse {
      Data: {
        Token: string;
        VerificationUrl: string;
        ExpiresIn: number;
        Interval: number;
      };
      Success: boolean;
    }

    const raw = await this.authRequest<RawInitResponse>(url);

    if (!raw.Success || !raw.Data) {
      throw new Error('Device flow init failed: server returned Success=false');
    }

    return {
      token: raw.Data.Token,
      verification_url: raw.Data.VerificationUrl,
      expires_in: raw.Data.ExpiresIn,
      interval: raw.Data.Interval,
      code_verifier: this.pkceVerifier ?? undefined,
    };
  }

  async deviceFlowPoll(token: string): Promise<DeviceFlowPollResponse> {
    const clientId = getOrCreateClientId();
    const baseUrl = this.getAuthBaseUrl();

    // Include PKCE code_verifier if available (from the init step)
    let url = `${baseUrl}/cli/device/token?client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(token)}`;
    if (this.pkceVerifier) {
      url += `&code_verifier=${encodeURIComponent(this.pkceVerifier)}`;
    }

    // The server may return one of two formats:
    //   A) PascalCase wrapped: { Data: { Status, Credentials? }, Success }
    //   B) Flat snake_case: { status, credentials? }
    // Both are accepted.
    interface RawPollResponse {
      // Format A
      Data?: {
        Status?: string;
        Credentials?: {
          AccessToken?: string;
          RefreshToken?: string;
          ExpireTime?: string;
          User?: { Id?: number; Email?: string; AliyunId?: string; Organization?: string };
        };
      };
      Success?: boolean;
      // Format B
      status?: string;
      credentials?: {
        access_token?: string;
        refresh_token?: string;
        expire_time?: string;
        user?: { id?: number; email?: string; aliyunId?: string; organization?: string };
      };
    }

    let raw: RawPollResponse;
    try {
      raw = await this.authRequest<RawPollResponse>(url);
    } catch (err) {
      // If the HTTP error response contains known device-flow error statuses,
      // return the proper status instead of throwing (per RFC 8628 §3.5)
      const message = err instanceof Error ? err.message : String(err);
      if (/expired/i.test(message)) {
        return { status: 'expired_token' };
      }
      if (/access_denied/i.test(message)) {
        return { status: 'access_denied' };
      }
      if (/slow_down/i.test(message)) {
        return { status: 'slow_down' };
      }
      throw err;
    }

    // Normalize status and credentials extraction
    const status = (
      raw.Data?.Status ??
      raw.status ??
      'authorization_pending'
    ).toLowerCase() as DeviceFlowPollResponse['status'];

    if (status === 'complete') {
      const cred = raw.Data?.Credentials;
      const credFlat = raw.credentials;

      const accessToken = cred?.AccessToken ?? credFlat?.access_token;
      const expireTime = cred?.ExpireTime ?? credFlat?.expire_time;
      // API may return AliyunId or Organization — accept both (auto-login.cjs compat)
      const user = cred?.User
        ? {
            id: cred.User.Id,
            email: cred.User.Email ?? '',
            aliyunId: cred.User.AliyunId ?? cred.User.Organization ?? '',
          }
        : credFlat?.user
          ? {
              id: credFlat.user.id,
              email: credFlat.user.email ?? '',
              aliyunId: credFlat.user.aliyunId ?? credFlat.user.organization ?? '',
            }
          : undefined;

      if (accessToken) {
        // Fallback: if API omits User entirely, try JWT claims for display
        const effectiveUser =
          user && (user.email || user.aliyunId)
            ? user
            : (tryExtractUserFromToken(accessToken) ?? user ?? { email: '', aliyunId: '' });
        return {
          status: 'complete',
          credentials: {
            access_token: accessToken,
            expires_at: expireTime ?? '',
            user: effectiveUser,
          },
        };
      }
    }

    return { status };
  }

  /**
   * Revoke session on the server side (best-effort).
   * POST {auth_endpoint}/cli/device/logout with Bearer token.
   * Network failures are silently ignored — local cleanup always proceeds.
   */
  async revokeSession(): Promise<boolean> {
    const resolved = resolveCredentials();
    if (!resolved) return false;

    const baseUrl = this.getAuthBaseUrl();
    const url = `${baseUrl}/cli/device/logout`;

    const reqHeaders: Record<string, string> = {
      Authorization: `Bearer ${resolved.access_token}`,
    };
    const debugId = isEnabled() ? startRequest('POST', url, reqHeaders, null, 'logout') : -1;

    const logoutController = new AbortController();
    const logoutTimeoutId = setTimeout(() => logoutController.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolved.access_token}`,
        },
        signal: logoutController.signal,
      });
      clearTimeout(logoutTimeoutId);
      if (debugId >= 0)
        endRequest(debugId, response.status, response.statusText, null, !response.ok);
      return response.ok;
    } catch {
      clearTimeout(logoutTimeoutId);
      // Best-effort: network failure / timeout is acceptable
      if (debugId >= 0) endRequest(debugId, null, 'NetworkError', null, true);
      return false;
    }
  }

  async ping(): Promise<{ latency: number; reachable: boolean; hostname: string }> {
    const endpoint = getEffectiveConfig()['api.endpoint'].replace(/\/+$/, '');
    const hostname = new URL(endpoint).hostname;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const start = Date.now();
      await fetch(endpoint, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return { latency: Date.now() - start, reachable: true, hostname };
    } catch {
      clearTimeout(timeoutId);
      return { latency: 0, reachable: false, hostname };
    }
  }

  async checkVersion(): Promise<{ current: string; latest: string; update_available: boolean }> {
    // Return locally-known version; no remote check in V1.
    const current = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0';
    return { current, latest: current, update_available: false };
  }
}

// Compatibility alias for client.ts dynamic imports
export { HttpApiClient as RealApiClient };
