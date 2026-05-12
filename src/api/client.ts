import type { ModelsListResponse, ModelDetail, Model } from '../types/model.js';
import type { UsageSummaryResponse, UsageBreakdownResponse } from '../types/usage.js';
import type { AuthStatus, DeviceFlowInitResponse, DeviceFlowPollResponse } from '../types/auth.js';

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

  // Auth
  getAuthStatus(): Promise<AuthStatus>;
  deviceFlowInit(): Promise<DeviceFlowInitResponse>;
  deviceFlowPoll(token: string): Promise<DeviceFlowPollResponse>;
  setPkceVerifier(verifier: string): void;
  revokeSession(): Promise<boolean>;

  // Health
  ping(): Promise<{ latency: number; reachable: boolean; hostname: string }>;
  checkVersion(): Promise<{
    current: string;
    latest: string;
    update_available: boolean;
  }>;
}

export async function createClient(_options?: { endpoint?: string }): Promise<ApiClient> {
  const { RealApiClient } = await import('./http-client.js');
  const realClient = new RealApiClient();

  return {
    listModels: (opts) => realClient.listModels(opts),
    searchModels: (keyword) => realClient.searchModels(keyword),
    fetchQuotasForModels: (models) => realClient.fetchQuotasForModels(models),
    getModel: (id) => realClient.getModel(id),
    getModels: (ids) => realClient.getModels(ids),
    getUsageSummary: (opts) => realClient.getUsageSummary(opts),
    getUsageBreakdown: (opts) => realClient.getUsageBreakdown(opts),
    getAuthStatus: () => realClient.getAuthStatus(),
    deviceFlowInit: () => realClient.deviceFlowInit(),
    deviceFlowPoll: (token) => realClient.deviceFlowPoll(token),
    setPkceVerifier: (verifier) => realClient.setPkceVerifier(verifier),
    revokeSession: () => realClient.revokeSession(),
    ping: () => realClient.ping(),
    checkVersion: () => realClient.checkVersion(),
  };
}
