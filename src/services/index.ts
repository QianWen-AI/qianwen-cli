/**
 * Composition root for the Service layer.
 *
 * `createServices()` is the single wiring point that builds the service graph
 * in the correct dependency order:
 *
 *   BaseClient → AuthClient   ↘
 *   BaseClient → ApiClient    → FreetierService  ↘
 *                              → BillingService  ↘
 *                              → TokenplanService → UsageService
 *                              → ModelsService (← FreetierService)
 *                              → AuthService    (← AuthClient)
 *
 * Sub-services are constructed once per call and shared across the resulting
 * container so internal caches (e.g., FreetierService's per-instance quota
 * memoization) survive across orchestrated calls within a single CLI run.
 */
import { createApiClient, type ApiClient } from '../api/api-client.js';
import {
  createAuthClient,
  type AuthClient,
  type CreateAuthClientOptions,
} from '../api/auth-client.js';
import { createBaseClient, type BaseClient } from '../api/base-client.js';
import { transformModelList, transformModelDetail } from '../api/adapters/model-adapter.js';
import {
  transformAutoRenewal,
  transformInstancesRenewable,
  transformOrderDetail,
  transformOrderList,
  transformSeatSubscriptionSummary,
  transformSubscriptionDetail,
  transformSubscriptionGray,
} from '../api/adapters/subscription-adapter.js';
import { getGlobalCache, getGlobalFileCache } from '../utils/cache.js';

import {
  BillingService,
  parseBillingItem,
  type BillingAdapter,
  type ParsedBillingItem,
} from './billing-service.js';
import { createCachedFetcher } from './cache-strategy.js';
import { FreetierService } from './freetier-service.js';
import { ModelsService, type ModelAdapter } from './models-service.js';
import { TokenplanService } from './tokenplan-service.js';
import { UsageService } from './usage-service.js';
import { AuthService } from './auth-service.js';
import { DocsService } from './docs-service.js';
import { WorkspaceService } from './workspace-service.js';
import { SubscriptionService, type SubscriptionAdapter } from './subscription-service.js';
import { SubscriptionTokenPlanService } from './subscription-tokenplan-service.js';
import { SupportService } from './support-service.js';

import type { CachedFetcher } from '../types/cache.js';
import type { ApiModelGroup, ApiModelItem, ConsumeSummaryLineItem } from '../types/api-models.js';
import type { Model, ModelDetail } from '../types/model.js';

// ────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────

export interface ServiceContainer {
  apiClient: ApiClient;
  authClient: AuthClient;
  cache: CachedFetcher;

  billingService: BillingService;
  freetierService: FreetierService;
  tokenplanService: TokenplanService;
  modelsService: ModelsService;
  usageService: UsageService;
  authService: AuthService;
  docsService: DocsService;
  workspaceService: WorkspaceService;
  subscriptionService: SubscriptionService;
  subscriptionTokenPlanService: SubscriptionTokenPlanService;
  supportService: SupportService;
}

export interface CreateServicesOptions {
  /** Inject a shared BaseClient (timeout reuse, test seam). */
  baseClient?: BaseClient;
  /** Override the request timeout (ms) for the api/auth clients. */
  timeoutMs?: number;
  /** Inject a pre-built ApiClient (test seam). */
  apiClient?: ApiClient;
  /** Inject a pre-built AuthClient (test seam). */
  authClient?: AuthClient;
  /** Inject a pre-built CachedFetcher (test seam). */
  cache?: CachedFetcher;
}

// ────────────────────────────────────────────────────────────────────
// Adapter factories — bridge module-scope pure functions into the DI
// adapter contracts consumed by the Service layer.
// ────────────────────────────────────────────────────────────────────

/** ModelAdapter factory: wraps the pure model-adapter transforms. */
function createModelAdapter(): ModelAdapter {
  return {
    toModelList(groups: ApiModelGroup[]): Model[] {
      return transformModelList(groups).models;
    },
    toModelDetail(item: ApiModelItem): ModelDetail {
      return transformModelDetail(item);
    },
  };
}

/** BillingAdapter factory: wraps the migrated parseBillingItem rule. */
function createBillingAdapter(): BillingAdapter {
  return {
    toNormalizedItem(item: ConsumeSummaryLineItem): ParsedBillingItem | null {
      return parseBillingItem(item, 'full');
    },
  };
}

/** SubscriptionAdapter factory: wraps the pure subscription-adapter transforms. */
function createSubscriptionAdapter(): SubscriptionAdapter {
  return {
    transformSubscriptionGray: (raw) => transformSubscriptionGray(raw),
    transformSeatSubscriptionSummary: (raw) => transformSeatSubscriptionSummary(raw),
    transformSubscriptionDetail: (raw) => transformSubscriptionDetail(raw),
    transformAutoRenewal: (raw) => transformAutoRenewal(raw),
    transformInstancesRenewable: (raw) => transformInstancesRenewable(raw),
    transformOrderList: (raw) => transformOrderList(raw),
    transformOrderDetail: (raw) => transformOrderDetail(raw),
  };
}

// ────────────────────────────────────────────────────────────────────
// createServices — top-level wiring
// ────────────────────────────────────────────────────────────────────

export function createServices(options: CreateServicesOptions = {}): ServiceContainer {
  const baseClient = options.baseClient ?? createBaseClient({ timeout: options.timeoutMs });
  const apiClient =
    options.apiClient ?? createApiClient({ baseClient, timeoutMs: options.timeoutMs });

  const authClientOpts: CreateAuthClientOptions = { baseClient };
  if (options.timeoutMs !== undefined) authClientOpts.timeoutMs = options.timeoutMs;
  const authClient = options.authClient ?? createAuthClient(authClientOpts);

  const cache = options.cache ?? createCachedFetcher(getGlobalCache(), getGlobalFileCache());

  // Adapter instances — pure, no state.
  const modelAdapter = createModelAdapter();
  const billingAdapter = createBillingAdapter();
  const subscriptionAdapter = createSubscriptionAdapter();

  // Leaf services (no peer dependencies).
  const freetierService = new FreetierService(apiClient, cache);
  const billingService = new BillingService(apiClient, billingAdapter, cache);
  const tokenplanService = new TokenplanService(apiClient, cache);

  // Composite services.
  const modelsService = new ModelsService(apiClient, modelAdapter, freetierService, cache);
  const usageService = new UsageService(
    apiClient,
    billingService,
    freetierService,
    tokenplanService,
    cache,
  );
  const authService = new AuthService(authClient);
  const docsService = new DocsService(apiClient);
  const workspaceService = new WorkspaceService(apiClient);
  const subscriptionService = new SubscriptionService(
    apiClient,
    subscriptionAdapter,
    cache,
    tokenplanService,
  );
  const subscriptionTokenPlanService = new SubscriptionTokenPlanService(apiClient);
  const supportService = new SupportService(apiClient);

  return {
    apiClient,
    authClient,
    cache,
    billingService,
    freetierService,
    tokenplanService,
    modelsService,
    usageService,
    authService,
    docsService,
    workspaceService,
    subscriptionService,
    subscriptionTokenPlanService,
    supportService,
  };
}
