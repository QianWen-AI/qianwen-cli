/** Flat-surface CLI-facing client that stitches services into the command contract. */
import type { ModelsListResponse, ModelDetail, Model } from '../types/model.js';
import type {
  UsageSummaryResponse,
  UsageBreakdownResponse,
  UsageLogsResponse,
} from '../types/usage.js';
import type { AuthStatus, DeviceFlowPollResponse } from '../types/auth.js';
import type { AuthModeContext, LoginInitResult } from '../services/auth-service.js';

import { getEffectiveConfig } from '../config/manager.js';
import { createServices, type ServiceContainer } from '../services/index.js';

export type ClientFactory = () => Promise<ApiClient>;

export interface ListModelsOptions {
  input?: string;
  output?: string;
}

export interface UsageSummaryOptions {
  from?: string;
  to?: string;
  period?: string;
}

export interface UsageBreakdownOptions {
  model: string;
  granularity?: 'day' | 'month' | 'quarter';
  from?: string;
  to?: string;
  period?: string;
  days?: number;
}

export interface UsageLogsOptions {
  from: string;
  to: string;
  models?: string[];
  statusCodeTypes?: ('CANCEL' | 'SUCCESS' | 'CLIENT_ERROR' | 'SERVER_ERROR')[];
  modelRequestId?: string;
  page?: number;
  pageSize?: number;
}

/**
 * ApiClient — broad-surface client used by the command layer. Retained as a
 * single point of indirection so commands stay decoupled from the service
 * graph's internal shape.
 */
export interface ApiClient {
  // Models
  listModels(options?: ListModelsOptions): Promise<ModelsListResponse>;
  getModel(id: string): Promise<ModelDetail>;
  getModels(ids: string[]): Promise<(ModelDetail | null)[]>;
  searchModels(keyword: string): Promise<ModelsListResponse>;
  fetchQuotasForModels(models: Model[]): Promise<Model[]>;

  // Usage
  getUsageSummary(options?: UsageSummaryOptions): Promise<UsageSummaryResponse>;
  getUsageBreakdown(options: UsageBreakdownOptions): Promise<UsageBreakdownResponse>;
  getUsageLogs(options: UsageLogsOptions): Promise<UsageLogsResponse>;

  // Auth
  getAuthStatus(): Promise<AuthStatus>;
  loginInit(ctx?: AuthModeContext): Promise<LoginInitResult>;
  loginPoll(
    token: string,
    intervalSec?: number,
    verifier?: string,
  ): Promise<DeviceFlowPollResponse>;
  revokeSession(): Promise<boolean>;

  // Health
  ping(): Promise<{ latency: number; reachable: boolean; hostname: string }>;
  checkVersion(): Promise<{
    current: string;
    latest: string;
    update_available: boolean;
  }>;
}

declare const __VERSION__: string;
declare const __NODE_ENV__: string;

/**
 * Resolve the effective api endpoint. In non-production builds the
 * QIANWEN_API_ENDPOINT env var overrides the configured value (used by the
 * E2E test harness to point the CLI at a local mock server).
 */
function resolveApiEndpoint(): string {
  const configured = (getEffectiveConfig()['api.endpoint'] as string).replace(/\/+$/, '');
  if (typeof __NODE_ENV__ !== 'undefined' && __NODE_ENV__ === 'production') {
    return configured;
  }
  const override = process.env.QIANWEN_API_ENDPOINT;
  return override ? override.replace(/\/+$/, '') : configured;
}

/** Lightweight HEAD probe of the configured api endpoint. */
async function pingEndpoint(): Promise<{
  latency: number;
  reachable: boolean;
  hostname: string;
}> {
  const endpoint = resolveApiEndpoint();
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

/** Build a CliFacade by composing the Service layer through `createServices`. */
export async function createClient(_options?: { endpoint?: string }): Promise<ApiClient> {
  const services: ServiceContainer = createServices();
  const { modelsService, usageService, authService } = services;

  return {
    // Models
    listModels: (opts) => modelsService.listModels(opts),
    searchModels: (keyword) => modelsService.searchModels(keyword),
    fetchQuotasForModels: (models) => modelsService.fetchQuotasForModels(models),
    getModel: (id) => modelsService.getModel(id),
    getModels: (ids) => modelsService.getModels(ids),

    // Usage
    getUsageSummary: (opts) => usageService.getUsageSummary(opts),
    getUsageBreakdown: (opts) => usageService.getUsageBreakdown(opts),
    getUsageLogs: (opts) => usageService.getUsageLogs(opts),

    // Auth
    getAuthStatus: () => authService.getAuthStatus(),
    loginInit: (ctx) => authService.loginInit(ctx),
    loginPoll: (token, intervalSec, verifier) =>
      authService.loginPoll(token, intervalSec, verifier),
    revokeSession: async () => {
      try {
        await authService.logout();
        return true;
      } catch {
        return false;
      }
    },

    // Health
    ping: () => pingEndpoint(),
    checkVersion: () => probeLatestVersion(),
  };
}
