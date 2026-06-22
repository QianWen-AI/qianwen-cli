/** Free-tier quota orchestration. */

import type { ApiClient } from '../api/api-client.js';
import type { CachedFetcher } from '../types/cache.js';
import type { FqInstanceItem, FqInstanceResponse } from '../types/api-models.js';
import type { FreeTierQuota, Model } from '../types/model.js';
import type { FreeTierUsage } from '../types/usage.js';
import { mapFqInstanceToQuota } from '../api/model-mapper/index.js';
import { addDiagnostic, isEnabled, startRequest, endRequest } from '../api/debug-buffer.js';
import { site } from '../site.js';

declare const __VERSION__: string;
declare const __NODE_ENV__: string;

// ────────────────────────────────────────────────────────────────────
// Wire format constants (flat-parameter protocol)
// ────────────────────────────────────────────────────────────────────

const API_PRODUCT_BSS = 'BssOpenAPI-V3';
const API_ACTION_DESCRIBE_FQ = 'DescribeFqInstance';
const REQUEST_TIMEOUT_MS = 30_000;

/** Resolve the CDN model-mapping URL. In dev builds, QIANWEN_CDN_ENDPOINT
 *  env var overrides the hardcoded CDN URL (for E2E / local testing). */
const CDN_MODEL_MAPPING_URL =
  typeof __NODE_ENV__ === 'undefined' || __NODE_ENV__ !== 'production'
    ? process.env.QIANWEN_CDN_ENDPOINT || site.features.cdnBaseUrl
    : site.features.cdnBaseUrl;

// ────────────────────────────────────────────────────────────────────
// Cache keys / TTLs (local to this service)
// ────────────────────────────────────────────────────────────────────

const CACHE_KEY_MODEL_MAPPING = 'models:mapping';
const CACHE_TTL_MODEL_MAPPING = 10 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────
// FreetierService
// ────────────────────────────────────────────────────────────────────

export class FreetierService {
  private readonly latestQuotaMap: Map<string, FreeTierQuota | null> = new Map();

  constructor(
    private readonly apiClient: ApiClient,
    private readonly cache: CachedFetcher,
  ) {}

  /** Resolve model-id → templateCode mapping. */
  async fetchModelMapping(): Promise<Record<string, string>> {
    return this.cache.getOrFetch(CACHE_KEY_MODEL_MAPPING, CACHE_TTL_MODEL_MAPPING, async () => {
      try {
        const debugId = isEnabled()
          ? startRequest('GET', CDN_MODEL_MAPPING_URL, {}, null, 'modelMapping')
          : -1;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        const response = await fetch(CDN_MODEL_MAPPING_URL, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': `qianwen-cli/${typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0'}`,
          },
        });
        clearTimeout(timer);
        if (debugId >= 0)
          endRequest(debugId, response.status, response.statusText, null, !response.ok);
        if (!response.ok) {
          throw new Error(`Failed to fetch model mapping: ${response.status}`);
        }
        return (await response.json()) as Record<string, string>;
      } catch (error) {
        addDiagnostic(
          'FreeTier',
          `Failed to load model mapping: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
        return {};
      }
    });
  }

  /** Batch-fetch free-tier quotas keyed by templateCode. Returns an empty
   *  map on upstream failure or empty input. */
  async fetchFreeTierQuotas(templateCodes: string[]): Promise<Map<string, FreeTierQuota>> {
    const quotaMap = new Map<string, FreeTierQuota>();
    if (templateCodes.length === 0) return quotaMap;

    try {
      const result = await this.apiClient.callFlatApi<FqInstanceResponse>({
        product: API_PRODUCT_BSS,
        action: API_ACTION_DESCRIBE_FQ,
        params: {
          templateCodes,
          PageSize: 500,
        },
      });

      const data = result?.Data ?? [];
      let hasMatchedInstance = false;
      for (const instance of data) {
        const isValidStatus =
          instance.Status === 'valid' ||
          instance.Status === 'exhaust' ||
          instance.Status === 'expire';
        if (
          isValidStatus &&
          instance.Template?.Code &&
          instance.InitCapacity &&
          instance.CurrCapacity
        ) {
          quotaMap.set(instance.Template.Code, mapFqInstanceToQuota(instance));
          hasMatchedInstance = true;
        }
      }

      if (!hasMatchedInstance && data.length > 0) {
        const details = data
          .map(
            (instance: FqInstanceItem, idx: number) =>
              `  [${idx}] Status: "${instance.Status}" (valid/exhaust/expire required), Template.Code: "${instance.Template?.Code || '(missing)'}"`,
          )
          .join('\n');
        addDiagnostic('FreeTier', `Parsed ${data.length} instances but none matched:\n${details}`);
      }
    } catch (error) {
      addDiagnostic(
        'FreeTier',
        `fetchFreeTierQuotas failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return quotaMap;
  }

  /** Augment a list of Models with per-id free-tier quota info. */
  async fetchQuotasForModels(models: Model[]): Promise<Model[]> {
    const freeTierModels = models.filter((m) => m.free_tier.mode === 'standard');
    if (freeTierModels.length === 0) return models;

    const mapping = await this.fetchModelMapping();
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

    const quotaMap = await this.fetchFreeTierQuotas([...codeToModelIds.keys()]);
    for (const code of codeToModelIds.keys()) {
      this.latestQuotaMap.set(code, quotaMap.get(code) ?? null);
    }

    const modelQuotaMap = new Map<string, FreeTierQuota>();
    for (const [code, ids] of codeToModelIds) {
      const quota = quotaMap.get(code);
      if (quota) for (const id of ids) modelQuotaMap.set(id, quota);
    }

    return models.map((m) => {
      const quota = modelQuotaMap.get(m.id);
      if (quota) return { ...m, free_tier: { ...m.free_tier, quota } };
      return m;
    });
  }

  /** Look up a memoized quota for a single templateCode. */
  peekCachedQuota(templateCode: string): FreeTierQuota | null | undefined {
    if (!this.latestQuotaMap.has(templateCode)) return undefined;
    return this.latestQuotaMap.get(templateCode) ?? null;
  }

  /** Update the per-instance quota memoization. */
  rememberQuota(templateCode: string, quota: FreeTierQuota | null): void {
    this.latestQuotaMap.set(templateCode, quota);
  }

  /** Build the per-model free-tier usage list. */
  async fetchFreeTierUsageList(): Promise<FreeTierUsage[]> {
    const mapping = await this.fetchModelMapping();
    const templateCodes = Object.values(mapping);
    if (templateCodes.length === 0) return [];

    const quotaMap = await this.fetchFreeTierQuotas(templateCodes);

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
}
