/**
 * Mock ApiClient factory for command-layer tests.
 *
 * All methods default to an "everything is fine, but empty" response so each
 * test only has to override the bits it cares about. Callers typically do:
 *
 *   const client = makeMockApiClient({
 *     listModels: async () => ({ models: [{ id: 'qwen3.6-plus', ... }], total: 1 }),
 *   });
 */
import type { ApiClient } from '../../src/api/client.js';
import type { Model } from '../../src/types/model.js';

export function makeMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const defaults: ApiClient = {
    listModels: async () => ({ models: [], total: 0 }),
    getModel: async (id: string) => {
      throw new Error(`Model '${id}' not found`);
    },
    getModels: async () => [],
    searchModels: async () => ({ models: [], total: 0 }),
    fetchQuotasForModels: async (models) => models,

    getUsageSummary: async () => ({
      period: { from: '2026-04-01', to: '2026-04-20' },
      free_tier: [],
      token_plan: { subscribed: false },
      pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
    }),
    getUsageBreakdown: async (opts) => ({
      model_id: opts.model,
      period: { from: '2026-04-01', to: '2026-04-20' },
      granularity: opts.granularity ?? 'day',
      rows: [],
      total: { cost: 0, currency: 'CNY' },
    }),

    getAuthStatus: async () => ({ authenticated: true, server_verified: true }),
    deviceFlowInit: async () => ({
      token: 't', verification_url: '', expires_in: 600, interval: 5,
    }),
    deviceFlowPoll: async () => ({ status: 'authorization_pending' }),
    setPkceVerifier: () => { /* no-op for tests */ },
    revokeSession: async () => true,

    ping: async () => ({ latency: 1, reachable: true, hostname: 'test' }),
    checkVersion: async () => ({ current: '1.0.0', latest: '1.0.0', update_available: false }),
  };
  return { ...defaults, ...overrides };
}

/** Convenience: minimal Model with sensible defaults. */
export function makeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: { mode: null, quota: null },
    ...overrides,
  } as Model;
}
