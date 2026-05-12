import type { UsageSummaryResponse, UsageBreakdownResponse } from '../../../src/types/usage.js';

// Mock summary data - the 3-section view from PRD §7.2.2
export const mockUsageSummary = {
  period: { from: '2026-04-01', to: '2026-04-07' },
  free_tier: [
    { model_id: 'qwen3.6-plus', quota: { remaining: 850000, total: 1000000, unit: 'tokens', used_pct: 15 } },
    { model_id: 'qwen-plus', quota: { remaining: 1000000, total: 1000000, unit: 'tokens', used_pct: 0 } },
    { model_id: 'wan2.6-t2i', quota: { remaining: 38, total: 50, unit: 'images', used_pct: 24 } },
    { model_id: 'cosyvoice-v3-plus', quota: { remaining: 7200, total: 10000, unit: 'characters', used_pct: 28 } },
    { model_id: 'qwen3.5-omni-plus', quota: null },
  ],
  token_plan: { subscribed: false },
  pay_as_you_go: {
    models: [
      { model_id: 'qwen3.6-plus', requests: 240, usage: { tokens_in: 480000, tokens_out: 120000 }, cost: 0.38, currency: 'CNY' },
      { model_id: 'qwen-plus', requests: 920, usage: { tokens_in: 460000, tokens_out: 115000 }, cost: 0.13, currency: 'CNY' },
      { model_id: 'wan2.6-t2i', requests: 12, usage: { images: 45 }, cost: 1.35, currency: 'CNY' },
      { model_id: 'cosyvoice-v3-plus', requests: 80, usage: { characters: 7200 }, cost: 0.21, currency: 'CNY' },
    ],
    total: { requests: 1252, cost: 2.07, currency: 'CNY' },
  },
};

// Mock breakdown data — daily for qwen3.6-plus (PRD §7.2.3 example 1)
export const mockBreakdownDaily = {
  model_id: 'qwen3.6-plus',
  period: { from: '2026-04-01', to: '2026-04-07' },
  granularity: 'day',
  rows: [
    { period: '2026-04-01', requests: 120, tokens_in: 58200, tokens_out: 14400, cost: 0.19, currency: 'CNY' },
    { period: '2026-04-02', requests: 98, tokens_in: 47500, tokens_out: 11800, cost: 0.16, currency: 'CNY' },
    { period: '2026-04-03', requests: 215, tokens_in: 104000, tokens_out: 26100, cost: 0.34, currency: 'CNY' },
    { period: '2026-04-04', requests: 87, tokens_in: 42200, tokens_out: 10500, cost: 0.14, currency: 'CNY' },
    { period: '2026-04-05', requests: 190, tokens_in: 92100, tokens_out: 23000, cost: 0.30, currency: 'CNY' },
    { period: '2026-04-06', requests: 143, tokens_in: 69400, tokens_out: 17300, cost: 0.23, currency: 'CNY' },
    { period: '2026-04-07', requests: 240, tokens_in: 116000, tokens_out: 29000, cost: 0.38, currency: 'CNY' },
  ],
  total: { requests: 1093, tokens_in: 529400, tokens_out: 132100, cost: 1.74, currency: 'CNY' },
};

// Mock breakdown data — monthly (PRD §7.2.3 example 2, Q1 2026)
export const mockBreakdownMonthly = {
  model_id: 'qwen3.6-plus',
  period: { from: '2026-01-01', to: '2026-03-31' },
  granularity: 'month',
  rows: [
    { period: '2026-01', requests: 3200, tokens_in: 1600000, tokens_out: 400000, cost: 2.54, currency: 'CNY' },
    { period: '2026-02', requests: 2800, tokens_in: 1400000, tokens_out: 350000, cost: 2.22, currency: 'CNY' },
    { period: '2026-03', requests: 4100, tokens_in: 2100000, tokens_out: 520000, cost: 3.28, currency: 'CNY' },
  ],
  total: { requests: 10100, tokens_in: 5100000, tokens_out: 1270000, cost: 8.04, currency: 'CNY' },
};

// Mock breakdown data — quarterly (PRD §7.2.3 example 3, past year)
export const mockBreakdownQuarterly = {
  model_id: 'qwen3.6-plus',
  period: { from: '2025-04-01', to: '2026-03-31' },
  granularity: 'quarter',
  rows: [
    { period: '2025-Q2', requests: 9800, tokens_in: 4900000, tokens_out: 1200000, cost: 7.84, currency: 'CNY' },
    { period: '2025-Q3', requests: 11200, tokens_in: 5600000, tokens_out: 1400000, cost: 8.93, currency: 'CNY' },
    { period: '2025-Q4', requests: 10500, tokens_in: 5300000, tokens_out: 1300000, cost: 8.41, currency: 'CNY' },
    { period: '2026-Q1', requests: 10100, tokens_in: 5100000, tokens_out: 1270000, cost: 8.04, currency: 'CNY' },
  ],
  total: { requests: 41600, tokens_in: 20900000, tokens_out: 5170000, cost: 33.22, currency: 'CNY' },
};

