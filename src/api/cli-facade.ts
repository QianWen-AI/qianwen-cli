/**
 * CliFacade — broad-surface CLI-facing client.
 *
 * Bundles the protocol entry points (api-client + auth-client) and exposes a
 * narrow set of business methods that command handlers consume. Each method
 * is a thin wrapper over `apiClient.callFlatApi` / `apiClient.callEnvelopeApi`
 * — the heavy adapters live in `./adapters/`, and the eventual Service layer
 * (Task #3) will absorb cross-call composition / caching / aggregation.
 *
 * Until then this façade keeps two responsibilities:
 *   1. Expose typed `apiClient` / `authClient` for direct callers and tests.
 *   2. Provide a small set of named conveniences (model lookup, free-tier /
 *      token-plan probes, raw consume-summary fetch) that the command layer
 *      can call without re-deriving the product/action constants.
 *
 * Network-only utilities that don't fit either layer (`ping`, `checkVersion`)
 * live here as plain helpers.
 */
import type { ApiClient } from './api-client.js';
import { createApiClient } from './api-client.js';
import type { AuthClient } from './auth-client.js';
import { createAuthClient } from './auth-client.js';
import { getEffectiveConfig } from '../config/manager.js';

import {
  API_PRODUCT_GATEWAY,
  API_ACTION_LIST_MODELS,
  API_ACTION_DESCRIBE_FQ,
  API_ACTION_DESCRIBE_FR,
  API_ACTION_CONSUME_SUMMARY,
} from '../types/api-routes.js';

import type {
  ApiModelGroup,
  ApiModelItem,
  ConsumeSummaryResponse,
  DescribeUsageLimitResponse,
  FqInstanceResponse,
  FrInstanceResponse,
} from '../types/api-models.js';

import { transformModelDetail, transformModelList } from './adapters/model-adapter.js';
import {
  transformConsumeSummary,
  transformFqInstances,
  transformFrInstances,
  transformUsageLimit,
  type ConsumeLineItemDTO,
  type FreeTierQuotaDTO,
  type TokenPlanDTO,
} from './adapters/billing-adapter.js';
import type { UsageLimit } from '../types/billing-extra.js';
import type { ModelDetail, ModelsListResponse } from '../types/model.js';

declare const __VERSION__: string;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface ListModelsOptions {
  input?: string;
  output?: string;
}

export interface DescribeFqOptions {
  templateCodes?: string[];
  pageSize?: number;
  currentPage?: number;
}

export interface DescribeFrOptions {
  commodityCodes?: string[];
  pageSize?: number;
  currentPage?: number;
}

export interface ConsumeSummaryOptions {
  from: string;
  to: string;
  pageSize?: number;
  currentPage?: number;
  workspaceId?: string;
}

/**
 * CliFacade — broad-surface entry point used by the command layer. Exposes
 * the protocol clients verbatim plus a curated set of business shortcuts.
 */
export interface CliFacade {
  // Protocol clients
  apiClient: ApiClient;
  authClient: AuthClient;

  // Models
  getModels(options?: ListModelsOptions): Promise<ModelsListResponse>;
  getModelDetail(id: string): Promise<ModelDetail>;

  // Billing primitives (raw or DTO-wrapped). Higher-level orchestration
  // (date-range splitting, page coalescing, etc.) belongs to the Service
  // layer (Task #3).
  listConsumeSummary(opts: ConsumeSummaryOptions): Promise<ConsumeLineItemDTO[]>;
  describeFqInstance(opts?: DescribeFqOptions): Promise<FreeTierQuotaDTO[]>;
  describeFrInstances(opts?: DescribeFrOptions): Promise<TokenPlanDTO>;
  getUsageLimit(): Promise<UsageLimit>;

  // Health
  ping(): Promise<{ latency: number; reachable: boolean; hostname: string }>;
  checkVersion(): Promise<{
    current: string;
    latest: string;
    update_available: boolean;
  }>;
}

export interface CreateCliFacadeOptions {
  apiClient?: ApiClient;
  authClient?: AuthClient;
}

// ────────────────────────────────────────────────────────────────────
// Health helpers
// ────────────────────────────────────────────────────────────────────

/** Lightweight HEAD probe of the configured api endpoint. */
async function pingEndpoint(): Promise<{
  latency: number;
  reachable: boolean;
  hostname: string;
}> {
  const endpoint = (getEffectiveConfig()['api.endpoint'] as string).replace(/\/+$/, '');
  const hostname = (() => {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return endpoint;
    }
  })();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const start = Date.now();
    await fetch(endpoint, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(timer);
    return { latency: Date.now() - start, reachable: true, hostname };
  } catch {
    clearTimeout(timer);
    return { latency: 0, reachable: false, hostname };
  }
}

/** CLI version probe via the upgrade-check module (no service dependency). */
async function probeLatestVersion(): Promise<{
  current: string;
  latest: string;
  update_available: boolean;
}> {
  const current = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0';
  const { fetchLatestVersion, compareVersions } = await import('../upgrade/check.js');
  const latest = await fetchLatestVersion();
  if (!latest) return { current, latest: current, update_available: false };
  return { current, latest, update_available: compareVersions(current, latest) < 0 };
}

// ────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────

export function createCliFacade(opts?: CreateCliFacadeOptions): CliFacade {
  const apiClient = opts?.apiClient ?? createApiClient();
  const authClient = opts?.authClient ?? createAuthClient();

  return {
    apiClient,
    authClient,

    async getModels(options?: ListModelsOptions): Promise<ModelsListResponse> {
      const params: Record<string, unknown> = {};
      if (options?.input) params.RequestModality = options.input;
      if (options?.output) params.ResponseModality = options.output;
      const inner = await apiClient.callFlatApi<{ Data: ApiModelGroup[] }>({
        product: API_PRODUCT_GATEWAY,
        action: API_ACTION_LIST_MODELS,
        params,
      });
      return transformModelList(inner?.Data ?? []);
    },

    async getModelDetail(id: string): Promise<ModelDetail> {
      const inner = await apiClient.callFlatApi<{ Data: ApiModelGroup[] } | ApiModelItem>({
        product: API_PRODUCT_GATEWAY,
        action: API_ACTION_LIST_MODELS,
        params: { Model: id },
      });
      const item = pickFirstModelItem(inner);
      if (!item) {
        throw new Error(`Model not found: ${id}`);
      }
      return transformModelDetail(item);
    },

    async listConsumeSummary(opts: ConsumeSummaryOptions): Promise<ConsumeLineItemDTO[]> {
      const params: Record<string, unknown> = {
        StartDate: opts.from,
        EndDate: opts.to,
        PageSize: opts.pageSize ?? 100,
        CurrentPage: opts.currentPage ?? 1,
      };
      if (opts.workspaceId) params.WorkspaceId = opts.workspaceId;
      const raw = await apiClient.callFlatApi<ConsumeSummaryResponse>({
        product: API_PRODUCT_GATEWAY,
        action: API_ACTION_CONSUME_SUMMARY,
        params,
      });
      return transformConsumeSummary(raw);
    },

    async describeFqInstance(opts?: DescribeFqOptions): Promise<FreeTierQuotaDTO[]> {
      const params: Record<string, unknown> = {
        PageSize: opts?.pageSize ?? 100,
        CurrentPage: opts?.currentPage ?? 1,
      };
      if (opts?.templateCodes && opts.templateCodes.length > 0) {
        params.TemplateCodes = opts.templateCodes;
      }
      const raw = await apiClient.callFlatApi<FqInstanceResponse>({
        product: API_PRODUCT_GATEWAY,
        action: API_ACTION_DESCRIBE_FQ,
        params,
      });
      return transformFqInstances(raw);
    },

    async describeFrInstances(opts?: DescribeFrOptions): Promise<TokenPlanDTO> {
      const params: Record<string, unknown> = {
        PageSize: opts?.pageSize ?? 100,
        CurrentPage: opts?.currentPage ?? 1,
      };
      if (opts?.commodityCodes && opts.commodityCodes.length > 0) {
        params.CommodityCodes = opts.commodityCodes;
      }
      const raw = await apiClient.callFlatApi<FrInstanceResponse>({
        product: API_PRODUCT_GATEWAY,
        action: API_ACTION_DESCRIBE_FR,
        params,
      });
      return transformFrInstances(raw);
    },

    async getUsageLimit(): Promise<UsageLimit> {
      const raw = await apiClient.callFlatApi<DescribeUsageLimitResponse>({
        product: API_PRODUCT_GATEWAY,
        action: 'DescribeUsageLimit',
        params: {},
      });
      return transformUsageLimit(raw);
    },

    ping: () => pingEndpoint(),
    checkVersion: () => probeLatestVersion(),
  };
}

// ────────────────────────────────────────────────────────────────────
// Local helpers
// ────────────────────────────────────────────────────────────────────

function pickFirstModelItem(
  raw: { Data?: ApiModelGroup[] } | ApiModelItem | null | undefined,
): ApiModelItem | null {
  if (!raw) return null;
  // Standard list shape: { Data: ApiModelGroup[] }
  const asList = raw as { Data?: ApiModelGroup[] };
  if (Array.isArray(asList.Data) && asList.Data.length > 0) {
    for (const group of asList.Data) {
      if (Array.isArray(group.Items) && group.Items.length > 0) {
        return group.Items[0]!;
      }
    }
  }
  // Detail shape: a single ApiModelItem returned inline.
  const asItem = raw as Partial<ApiModelItem>;
  if (typeof asItem.Model === 'string' && asItem.Model.length > 0) {
    return raw as ApiModelItem;
  }
  return null;
}
