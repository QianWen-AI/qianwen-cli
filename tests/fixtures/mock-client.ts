import type { ApiClient, ListModelsOptions, UsageSummaryOptions, UsageBreakdownOptions } from '../../src/api/client.js';
import type { ModelsListResponse, ModelDetail, Model } from '../../src/types/model.js';
import type { UsageSummaryResponse, UsageBreakdownResponse } from '../../src/types/usage.js';
import type {
  AuthStatus,
  DeviceFlowInitResponse,
  DeviceFlowPollResponse,
} from '../../src/types/auth.js';
import { mockModels as mockModelsRaw } from './mock-data/models.js';
import {
  mockUsageSummary as mockUsageSummaryRaw,
  mockBreakdownDaily as mockBreakdownDailyRaw,
  mockBreakdownMonthly as mockBreakdownMonthlyRaw,
  mockBreakdownQuarterly as mockBreakdownQuarterlyRaw,
} from './mock-data/usage.js';
const mockModels = mockModelsRaw as any[];
const mockUsageSummary = mockUsageSummaryRaw as any;
const mockBreakdownDaily = mockBreakdownDailyRaw as any;
const mockBreakdownMonthly = mockBreakdownMonthlyRaw as any;
const mockBreakdownQuarterly = mockBreakdownQuarterlyRaw as any;
import { mockAuthStatus, mockCredentials, mockDeviceFlowInit } from './mock-data/auth.js';

/**
 * Mock API client for development and testing.
 * Returns rich mock datasets based on PRD examples.
 */
export class MockApiClient implements ApiClient {
  async listModels(options?: ListModelsOptions): Promise<ModelsListResponse> {
    let models = mockModels.map(toListModel);

    // Filter by input modality
    if (options?.input) {
      const input = options.input.toLowerCase();
      models = models.filter((m) => m.modality.input.includes(input as any));
    }

    // Filter by output modality
    if (options?.output) {
      const output = options.output.toLowerCase();
      models = models.filter((m) => m.modality.output.includes(output as any));
    }

    return { models, total: models.length };
  }

  async getModel(id: string): Promise<ModelDetail> {
    const model = mockModels.find((m) => m.id === id);
    if (!model) {
      throw new Error(`Model '${id}' not found.`);
    }
    return model;
  }

  async getModels(ids: string[]): Promise<(ModelDetail | null)[]> {
    return ids.map(id => {
      const model = mockModels.find((m) => m.id === id);
      return model ?? null;
    });
  }

  async fetchQuotasForModels(models: Model[]): Promise<Model[]> {
    // Mock client: return models as-is (no real quota API)
    return models;
  }

  async searchModels(keyword: string): Promise<ModelsListResponse> {
    const kw = keyword.toLowerCase();
    const matched = mockModels.filter((m: any) => {
      // Search across id, description, tags, modality values
      if (m.id.toLowerCase().includes(kw)) return true;
      if (m.description.toLowerCase().includes(kw)) return true;
      if (m.tags.some((t: any) => t.toLowerCase().includes(kw))) return true;
      if (m.modality.input.some((v: any) => v.toLowerCase().includes(kw))) return true;
      if (m.modality.output.some((v: any) => v.toLowerCase().includes(kw))) return true;
      return false;
    });

    const models = matched.map(toListModel);
    return { models, total: models.length };
  }

  async getUsageSummary(_options?: UsageSummaryOptions): Promise<UsageSummaryResponse> {
    // Adjust period based on options if provided, otherwise return default mock
    const summary = { ...mockUsageSummary };
    if (_options?.from || _options?.to) {
      summary.period = {
        from: _options.from ?? mockUsageSummary.period.from,
        to: _options.to ?? mockUsageSummary.period.to,
      };
    }
    return summary;
  }

  async getUsageBreakdown(options: UsageBreakdownOptions): Promise<UsageBreakdownResponse> {
    const granularity = options.granularity ?? 'day';

    // Select appropriate breakdown based on granularity
    switch (granularity) {
      case 'quarter':
        return { ...mockBreakdownQuarterly, model_id: options.model };
      case 'month':
        return { ...mockBreakdownMonthly, model_id: options.model };
      case 'day':
      default:
        return { ...mockBreakdownDaily, model_id: options.model };
    }
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return { ...mockAuthStatus, server_verified: true };
  }

  async deviceFlowInit(): Promise<DeviceFlowInitResponse> {
    return mockDeviceFlowInit;
  }

  setPkceVerifier(_verifier: string): void { /* no-op for mock client */ }

  async deviceFlowPoll(_token: string): Promise<DeviceFlowPollResponse> {
    // Simulate success after a short delay
    return {
      status: 'complete',
      credentials: mockCredentials,
    };
  }

  async revokeSession(): Promise<boolean> {
    return true;
  }

  async ping(): Promise<{ latency: number; reachable: boolean; hostname: string }> {
    return { latency: 42, reachable: true, hostname: 'mock.qianwenai.com' };
  }

  async checkVersion(): Promise<{ current: string; latest: string; update_available: boolean }> {
    return { current: '1.0.0', latest: '1.0.0', update_available: false };
  }
}

/** Strip detail fields to produce a Model list item */
function toListModel(detail: ModelDetail): Model {
  return {
    id: detail.id,
    modality: detail.modality,
    can_try: detail.can_try,
    free_tier: detail.free_tier,
  };
}
