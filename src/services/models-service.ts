/**
 * ModelsService — model catalog orchestration.
 *
 * Responsibilities:
 *   - List/detail/search of the model catalog via the flat-parameter protocol.
 *   - Free-tier quota merging via the injected FreetierService.
 *   - Local keyword matching (case- and accent-insensitive) for searchModels.
 *   - L1/L2 cache reads via the injected CachedFetcher.
 */

import type { ApiClient } from '../api/api-client.js';
import type { CachedFetcher } from '../types/cache.js';
import type {
  Model,
  ModelDetail,
  ModelsListResponse,
  ModalityType,
  FreeTierQuota,
} from '../types/model.js';
import type { ApiModelItem, ApiModelsListResponse } from '../types/api-models.js';
import {
  flattenApiModels,
  mapApiModelToModel,
  mapApiModelToModelDetail,
} from '../api/model-mapper/index.js';
import { normalizeForSearch } from '../utils/search-normalize.js';
import { isReplMode } from '../utils/runtime-mode.js';
import { site } from '../site.js';
import { API_PRODUCT_DELIVERY } from '../types/api-routes.js';
import type { FreetierService } from './freetier-service.js';

// ────────────────────────────────────────────────────────────────────
// Wire format constants (flat-parameter protocol)
// ────────────────────────────────────────────────────────────────────

const API_ACTION_LIST_MODELS = 'ListModelSeries';

// ────────────────────────────────────────────────────────────────────
// Cache keys / TTLs (local to this service)
// ────────────────────────────────────────────────────────────────────

const CACHE_KEY_MODELS_RAW = 'models:raw_list';
const CACHE_TTL_MODELS_RAW = 10 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface ListModelsOptions {
  input?: string;
  output?: string;
}

/** ModelAdapter contract — raw API → DTO transformations. */
export interface ModelAdapter {
  toModelList(groups: import('../types/api-models.js').ApiModelGroup[]): Model[];
  toModelDetail(item: ApiModelItem): ModelDetail;
}

// ────────────────────────────────────────────────────────────────────
// ModelsService
// ────────────────────────────────────────────────────────────────────

export class ModelsService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly modelAdapter: ModelAdapter,
    private readonly freetierService: FreetierService,
    private readonly cache: CachedFetcher,
  ) {}

  /** List models. Caches raw API data (10 min). */
  async listModels(options?: ListModelsOptions): Promise<ModelsListResponse> {
    const rawItems = await this.cache.getOrFetch(
      CACHE_KEY_MODELS_RAW,
      CACHE_TTL_MODELS_RAW,
      async () => this.fetchRawModels(),
    );

    const mapping = await this.freetierService.fetchModelMapping();
    const models = rawItems.map((item: ApiModelItem) => {
      const templateCode = mapping[item.Model];
      const hasFreeTier = !!templateCode;
      return mapApiModelToModel(item, hasFreeTier, null);
    });

    return this.filterModels({ models, total: models.length }, options);
  }

  /** One-shot mode: gateway Query+MatchOnly. REPL mode: cache-based path. */
  async getModel(id: string): Promise<ModelDetail> {
    return isReplMode() ? this.getModelFromCache(id) : this.getModelByQuery(id);
  }

  /** Batch-fetch model details. Returns null for ids that cannot be resolved. */
  async getModels(ids: string[]): Promise<(ModelDetail | null)[]> {
    if (ids.length === 0) return [];

    const rawItems = await this.cache.getOrFetch(
      CACHE_KEY_MODELS_RAW,
      CACHE_TTL_MODELS_RAW,
      async () => this.fetchRawModels(),
    );

    const mapping = await this.freetierService.fetchModelMapping();
    const itemMap = new Map<string, ApiModelItem>();
    for (const item of rawItems) itemMap.set(item.Model, item);

    const templateCodes: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const apiItem = itemMap.get(id);
      if (apiItem) {
        const code = mapping[apiItem.Model];
        if (code && !seen.has(code) && this.freetierService.peekCachedQuota(code) === undefined) {
          templateCodes.push(code);
          seen.add(code);
        }
      }
    }

    if (templateCodes.length > 0) {
      const quotaMap = await this.freetierService.fetchFreeTierQuotas(templateCodes);
      for (const code of templateCodes) {
        this.freetierService.rememberQuota(code, quotaMap.get(code) ?? null);
      }
    }

    return ids.map((id) => {
      const apiItem = itemMap.get(id);
      if (!apiItem) return null;
      const templateCode = mapping[apiItem.Model];
      const hasFreeTier = !!templateCode;
      const quota = templateCode
        ? (this.freetierService.peekCachedQuota(templateCode) ?? null)
        : null;
      return mapApiModelToModelDetail(apiItem, hasFreeTier, quota);
    });
  }

  /** Local keyword filter; case- and accent-insensitive. */
  async searchModels(keyword: string): Promise<ModelsListResponse> {
    const listResponse = await this.listModels();
    const needle = normalizeForSearch(keyword);
    const matches = (haystack: string | undefined): boolean =>
      !!haystack && normalizeForSearch(haystack).includes(needle);

    const rawItems = await this.cache
      .getOrFetch(CACHE_KEY_MODELS_RAW, CACHE_TTL_MODELS_RAW, async () => this.fetchRawModels())
      .catch(() => [] as ApiModelItem[]);
    const rawIndex = new Map<string, ApiModelItem>();
    for (const item of rawItems) rawIndex.set(item.Model, item);

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

    return { models: filtered, total: filtered.length };
  }

  /** Delegate FreeTier quota merging to FreetierService. */
  async fetchQuotasForModels(models: Model[]): Promise<Model[]> {
    return this.freetierService.fetchQuotasForModels(models);
  }

  // ────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────

  private async fetchRawModels(): Promise<ApiModelItem[]> {
    const rawResponse = await this.apiClient.callFlatApi<ApiModelsListResponse['data']>({
      product: API_PRODUCT_DELIVERY,
      action: API_ACTION_LIST_MODELS,
      params: { Language: site.defaults.language },
    });
    if (!rawResponse?.Data) {
      throw new Error('Models API returned empty payload');
    }
    void this.modelAdapter;
    return flattenApiModels(rawResponse.Data);
  }

  private filterModels(
    result: ModelsListResponse,
    options?: ListModelsOptions,
  ): ModelsListResponse {
    let models = result.models;
    const filterByModality = (key: 'input' | 'output', value?: string): void => {
      if (!value) return;
      const list = value.split(',').map((m) => m.trim().toLowerCase() as ModalityType);
      models = models.filter((m) => list.every((mod) => m.modality[key].includes(mod)));
    };
    filterByModality('input', options?.input);
    filterByModality('output', options?.output);
    return { models, total: models.length };
  }

  private async getModelByQuery(id: string): Promise<ModelDetail> {
    const mapping = await this.freetierService.fetchModelMapping();
    const cached = await this.cache
      .getOrFetch<
        ApiModelItem[]
      >(CACHE_KEY_MODELS_RAW, CACHE_TTL_MODELS_RAW, async () => this.fetchRawModels())
      .catch(() => [] as ApiModelItem[]);
    let apiItem = cached.find((item) => item.Model === id);

    if (!apiItem) {
      const rawResponse = await this.apiClient.callFlatApi<ApiModelsListResponse['data']>({
        product: API_PRODUCT_DELIVERY,
        action: API_ACTION_LIST_MODELS,
        params: { Language: site.defaults.language, Query: id, MatchOnly: true },
      });
      if (!rawResponse?.Data) throw new Error(`Model '${id}' not found`);
      const items = flattenApiModels(rawResponse.Data);
      apiItem = items.find((item) => item.Model === id);
      if (!apiItem) throw new Error(`Model '${id}' not found`);
    }

    return this.resolveDetailWithQuota(apiItem, mapping);
  }

  private async getModelFromCache(id: string): Promise<ModelDetail> {
    const rawItems = await this.cache.getOrFetch(
      CACHE_KEY_MODELS_RAW,
      CACHE_TTL_MODELS_RAW,
      async () => this.fetchRawModels(),
    );
    const apiItem = rawItems.find((item) => item.Model === id);
    if (!apiItem) throw new Error(`Model '${id}' not found`);

    const mapping = await this.freetierService.fetchModelMapping();
    return this.resolveDetailWithQuota(apiItem, mapping);
  }

  private async resolveDetailWithQuota(
    apiItem: ApiModelItem,
    mapping: Record<string, string>,
  ): Promise<ModelDetail> {
    const templateCode = mapping[apiItem.Model];
    const hasFreeTier = !!templateCode;
    let quota: FreeTierQuota | null = null;

    if (templateCode) {
      const cached = this.freetierService.peekCachedQuota(templateCode);
      if (cached !== undefined) {
        quota = cached;
      } else {
        const quotaMap = await this.freetierService.fetchFreeTierQuotas([templateCode]);
        quota = quotaMap.get(templateCode) ?? null;
        this.freetierService.rememberQuota(templateCode, quota);
      }
    }

    return mapApiModelToModelDetail(apiItem, hasFreeTier, quota);
  }
}
