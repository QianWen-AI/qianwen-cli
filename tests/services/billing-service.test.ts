/** Unit tests for BillingService. */
import { describe, it, expect, vi } from 'vitest';
import {
  BillingService,
  inferBillingUnit,
  computeUsageValue,
  parseBillingItem,
  splitIntoMonths,
  sumAmountStrings,
  SKIP_LINE_ITEM_CATEGORIES,
} from '../../src/services/billing-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';
import type { CallFlatApiOptions } from '../../src/api/api-client.js';
import type { ConsumeSummaryLineItem } from '../../src/types/api-models.js';

// inferBillingUnit

describe('inferBillingUnit', () => {
  it('detects unit from billingItemCode keywords', () => {
    expect(inferBillingUnit('', 'image_number')).toBe('images');
    expect(inferBillingUnit('', 'video_duration')).toBe('seconds');
    expect(inferBillingUnit('', 'char_number')).toBe('characters');
    expect(inferBillingUnit('', 'voice_count')).toBe('voices');
    expect(inferBillingUnit('', 'token_number')).toBe('tokens');
  });

  it('falls back to stepUnit when billingItemCode has no keyword', () => {
    expect(inferBillingUnit('1K tokens', '')).toBe('tokens');
    expect(inferBillingUnit('Per 1 image', '')).toBe('images');
    expect(inferBillingUnit('second', '')).toBe('seconds');
    expect(inferBillingUnit('characters', '')).toBe('characters');
    expect(inferBillingUnit('voice output', '')).toBe('voices');
  });

  it('extracts from "Per <N> <unit>" pattern', () => {
    expect(inferBillingUnit('Per 1000 requests', '')).toBe('requests');
  });

  it('defaults to tokens when nothing matches', () => {
    expect(inferBillingUnit('', '')).toBe('tokens');
    expect(inferBillingUnit('unknown thing', '')).toBe('tokens');
  });
});

// computeUsageValue

describe('computeUsageValue', () => {
  it('returns 0 for zero billQuantity', () => {
    expect(computeUsageValue(0, '1K tokens')).toBe(0);
  });

  it('multiplies by 10_000 for tenthousand / 万字 units', () => {
    expect(computeUsageValue(5, 'Per tenthousand characters')).toBe(50_000);
    expect(computeUsageValue(2, '万字')).toBe(20_000);
  });

  it('detects numeric multiplier with K/M suffix', () => {
    expect(computeUsageValue(3, '1K tokens')).toBe(3_000);
    expect(computeUsageValue(2, 'Per 1M tokens')).toBe(2_000_000);
    expect(computeUsageValue(4, '500 tokens')).toBe(2_000);
  });

  it('returns billQuantity directly when multiplier=1', () => {
    expect(computeUsageValue(7, 'Per 1 image')).toBe(7);
  });

  it('passes through when no numeric pattern matches', () => {
    expect(computeUsageValue(42, 'items')).toBe(42);
  });
});

// parseBillingItem

describe('parseBillingItem', () => {
  it('parses a standard line item', () => {
    const item: ConsumeSummaryLineItem = {
      LineItemCategory: 'LLM Token Consumption',
      BillingDate: '2026-06-01',
      BillingMonth: '2026-06',
      ModelName: 'qwen-plus',
      BillQuantity: 10,
      StepQuantityUnit: '1K tokens',
      BillingItemCode: 'token_number',
      RequireAmount: 1.5,
    };
    const out = parseBillingItem(item);
    expect(out).toEqual({
      lineItemCat: 'LLM Token Consumption',
      billingDate: '2026-06-01',
      billingMonth: '2026-06',
      modelId: 'qwen-plus',
      usageValue: 10_000,
      cost: 1.5,
      billingUnit: 'tokens',
      isFree: false,
    });
  });

  it('returns null for SKIP_LINE_ITEM_CATEGORIES', () => {
    expect(parseBillingItem({ LineItemCategory: 'Rounding Adjustment' })).toBeNull();
    expect(parseBillingItem({ LineItemCategory: 'Refund' })).toBeNull();
    expect(parseBillingItem({ LineItemCategory: 'Credit Adjustment' })).toBeNull();
  });

  it('marks isFree when category includes "free"', () => {
    const out = parseBillingItem({ LineItemCategory: 'Free Tier Image Generation' });
    expect(out?.isFree).toBe(true);
  });

  it('falls back modelId through Model → JobId → MaasTypeName → Other', () => {
    expect(parseBillingItem({ Model: 'M' })?.modelId).toBe('M');
    expect(parseBillingItem({ JobId: 'J' })?.modelId).toBe('J');
    expect(parseBillingItem({ MaasTypeName: 'T' })?.modelId).toBe('T');
    expect(parseBillingItem({})?.modelId).toBe('Other');
  });

  it('respects costMode=minimal (RequireAmount → ListPrice, skip Amount/Cost)', () => {
    const item: ConsumeSummaryLineItem = {
      RequireAmount: undefined,
      Amount: 999,
      ListPrice: 3.5,
    };
    const out = parseBillingItem(item, 'minimal');
    expect(out?.cost).toBe(3.5);
  });
});

// splitIntoMonths

describe('splitIntoMonths', () => {
  it('returns single range when from and to are in the same month', () => {
    expect(splitIntoMonths('2026-06-01', '2026-06-15')).toEqual([['2026-06-01', '2026-06-15']]);
  });

  it('splits across multiple months', () => {
    const out = splitIntoMonths('2026-05-15', '2026-07-10');
    expect(out).toEqual([
      ['2026-05-15', '2026-05-31'],
      ['2026-06-01', '2026-06-30'],
      ['2026-07-01', '2026-07-10'],
    ]);
  });

  it('handles year boundary', () => {
    const out = splitIntoMonths('2025-12-20', '2026-01-05');
    expect(out).toEqual([
      ['2025-12-20', '2025-12-31'],
      ['2026-01-01', '2026-01-05'],
    ]);
  });

  it('handles February (non-leap year)', () => {
    const out = splitIntoMonths('2025-02-01', '2025-02-28');
    expect(out).toEqual([['2025-02-01', '2025-02-28']]);
  });
});

// sumAmountStrings

describe('sumAmountStrings', () => {
  it('returns "0" for empty input', () => {
    expect(sumAmountStrings([])).toBe('0');
  });

  it('sums decimal strings without IEEE-754 drift', () => {
    expect(sumAmountStrings(['0.1', '0.2'])).toBe('0.3');
  });

  it('sums a mix of positive and zero', () => {
    expect(sumAmountStrings(['1.23', '4.56', '0'])).toBe('5.79');
  });

  it('strips trailing zeros', () => {
    expect(sumAmountStrings(['1.500', '0.500'])).toBe('2');
  });
});

// BillingService class methods

const stubBillingAdapter = {
  toNormalizedItem: (item: ConsumeSummaryLineItem) => parseBillingItem(item),
};

describe('BillingService.getUsageLimit', () => {
  it('issues DescribeUsageLimit and delegates to transformUsageLimit', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.action).toBe('DescribeUsageLimit');
        expect(opts.product).toBe('BssOpenAPI-V3');
        return {
          Status: 'NORMAL',
          LimitAmount: '500',
          Currency: 'CNY',
          AlertThreshold: '400',
          Receivers: ['admin@test.qianwen.com'],
        };
      },
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getUsageLimit();
    expect(out.status).toBe('NORMAL');
    expect(out.limitAmount).toBe('500');
    expect(out.currency).toBe('CNY');
  });
});

describe('BillingService.getPaygSummary', () => {
  it('fetches consume data per month and aggregates by model', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: [
          {
            ModelName: 'qwen-plus',
            BillingDate: '2026-06-01',
            BillingMonth: '2026-06',
            BillQuantity: 10,
            StepQuantityUnit: '1K tokens',
            BillingItemCode: 'token_number',
            RequireAmount: 2,
            LineItemCategory: 'LLM Token Consumption',
          },
          {
            ModelName: 'qwen-plus',
            BillingDate: '2026-06-02',
            BillingMonth: '2026-06',
            BillQuantity: 5,
            StepQuantityUnit: '1K tokens',
            BillingItemCode: 'token_number',
            RequireAmount: 1,
            LineItemCategory: 'LLM Token Consumption',
          },
        ],
      }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getPaygSummary({ from: '2026-06-01', to: '2026-06-30' });

    expect(out.models).toHaveLength(1);
    expect(out.models[0]?.model_id).toBe('qwen-plus');
    expect(out.models[0]?.cost).toBeCloseTo(3, 10);
    expect(out.total.cost).toBeCloseTo(3, 10);
    expect(out.total.currency).toBe('CNY');
  });

  it('skips free-tier items', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: [
          {
            ModelName: 'qwen-free',
            BillQuantity: 99,
            StepQuantityUnit: '1K tokens',
            LineItemCategory: 'Free Tier Token Consumption',
            RequireAmount: 0,
          },
        ],
      }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getPaygSummary({ from: '2026-06-01', to: '2026-06-30' });
    expect(out.models).toHaveLength(0);
  });

  it('issues one callFlatApi per calendar month in the range', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Data: [] }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    await svc.getPaygSummary({ from: '2026-05-15', to: '2026-07-10' });
    // splitIntoMonths should give 3 sub-ranges
    expect(api.callFlatApi).toHaveBeenCalledTimes(3);
  });
});

describe('BillingService.getPaygBreakdown', () => {
  it('returns shaped UsageBreakdownResponse with day granularity', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: [
          {
            ModelName: 'qwen-plus',
            BillingDate: '2026-06-01',
            BillingMonth: '2026-06',
            BillQuantity: 10,
            StepQuantityUnit: '1K tokens',
            BillingItemCode: 'token_number',
            RequireAmount: 2,
            LineItemCategory: 'LLM Token Consumption',
          },
        ],
      }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getPaygBreakdown({
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'day',
      modelFilter: 'qwen-plus',
    });
    expect(out.model_id).toBe('qwen-plus');
    expect(out.granularity).toBe('day');
    expect(out.period).toEqual({ from: '2026-06-01', to: '2026-06-01' });
    expect(out.total.cost).toBeGreaterThan(0);
  });

  it('returns month granularity aggregation', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Data: [
          {
            ModelName: 'qwen-plus',
            BillingDate: '2026-06-01',
            BillingMonth: '2026-06',
            BillQuantity: 5,
            StepQuantityUnit: '1K tokens',
            BillingItemCode: 'token_number',
            RequireAmount: 1,
            LineItemCategory: 'Token',
          },
          {
            ModelName: 'qwen-plus',
            BillingDate: '2026-06-15',
            BillingMonth: '2026-06',
            BillQuantity: 5,
            StepQuantityUnit: '1K tokens',
            BillingItemCode: 'token_number',
            RequireAmount: 1,
            LineItemCategory: 'Token',
          },
        ],
      }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getPaygBreakdown({
      from: '2026-06-01',
      to: '2026-06-30',
      granularity: 'month',
    });
    expect(out.granularity).toBe('month');
    expect(out.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('normalizes YYYY-MM range to YYYY-MM-DD before calling API', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Data: [] }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getPaygBreakdown({
      from: '2026-05',
      to: '2026-05',
      granularity: 'day',
    });
    expect(api.callFlatApi).toHaveBeenCalledTimes(1);
    const callParams = api.callFlatApi.mock.calls[0]?.[0]?.params as {
      StartBillingDate: string;
      EndBillingDate: string;
    };
    expect(callParams.StartBillingDate).toBe('2026-05-01');
    expect(callParams.EndBillingDate).toBe('2026-05-31');
    expect(out.period).toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });

  it('getPaygSummary normalizes YYYY-MM inputs before calling API', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Data: [] }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    await svc.getPaygSummary({ from: '2026-04', to: '2026-04' });
    const callParams = api.callFlatApi.mock.calls[0]?.[0]?.params as {
      StartBillingDate: string;
      EndBillingDate: string;
    };
    expect(callParams.StartBillingDate).toBe('2026-04-01');
    expect(callParams.EndBillingDate).toBe('2026-04-30');
  });
});

describe('BillingService.getConsumeBreakdown', () => {
  it('issues MaasDescribeCostAnalysis with DimField from groupBy map', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.action).toBe('MaasDescribeCostAnalysis');
        expect(opts.params).toMatchObject({
          BizType: 'MAAS_CONSUME_ANALYSIS',
          Granularity: 'DAY',
          GroupBy: [{ Code: 'API_KEY_ID', Type: 'Dimensions' }],
        });
        return {};
      },
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getConsumeBreakdown({
      groupBy: 'api-key',
      from: '2026-06-01',
      to: '2026-06-30',
      chargeType: 'postpaid',
      top: 10,
      granularity: 'day',
    });
    expect(out.groupBy).toBe('api-key');
    expect(out.currency).toBe('CNY');
  });

  it('maps groupBy "api-key" to the API_KEY_ID dimension (not MODEL_NAME)', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.action).toBe('MaasDescribeCostAnalysis');
        expect(opts.params).toMatchObject({
          GroupBy: [{ Code: 'API_KEY_ID', Type: 'Dimensions' }],
        });
        return {};
      },
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getConsumeBreakdown({
      groupBy: 'api-key',
      from: '2026-06-01',
      to: '2026-06-30',
      chargeType: 'all',
      top: 10,
    });
    expect(out.groupBy).toBe('api-key');
  });

  it('excludes TaxFee via Filter and returns only pretax rows', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        GroupByTotal: [
          { Key: 'qwen-plus', Name: 'qwen-plus', Amount: '10.00' },
          { Key: 'qwen-max', Name: 'qwen-max', Amount: '5.00' },
        ],
      }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const result = await svc.getConsumeBreakdown({
      from: '2026-04-01',
      to: '2026-04-30',
      groupBy: 'model',
      chargeType: 'all',
      top: 10,
      granularity: 'day',
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].amount).toBe('10.00');
    expect(result.rows[1].amount).toBe('5.00');
    // Verify Filter param excludes TaxFee
    const call = (api.callFlatApi as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.params.Filter).toEqual({
      Dimensions: [{ Code: 'LINE_ITEM_CATEGORY', Values: ['TaxFee'], SelectType: 'NOT' }],
    });
  });

  it('month granularity uses single API call with YYYYMM format', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        GroupByTotal: [
          { Key: 'qwen-plus', Name: 'qwen-plus', Amount: '50.00' },
        ],
      }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const result = await svc.getConsumeBreakdown({
      from: '2026-01-01',
      to: '2026-06-30',
      groupBy: 'model',
      chargeType: 'all',
      top: 10,
      granularity: 'month',
    });
    // Single call (no paired tax call)
    expect(api.callFlatApi).toHaveBeenCalledTimes(1);
    const call = (api.callFlatApi as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.params.Granularity).toBe('MONTH');
    expect(call.params.TimePeriod).toEqual({ Start: '202601', End: '202606' });
    expect(result.rows).toHaveLength(1);
  });

  it('day granularity splits into monthly sub-ranges with single call per range', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        GroupByTotal: [
          { Key: 'qwen-max', Name: 'qwen-max', Amount: '10.00' },
        ],
      }),
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    await svc.getConsumeBreakdown({
      from: '2026-05-15',
      to: '2026-06-15',
      groupBy: 'model',
      chargeType: 'all',
      top: 10,
      granularity: 'day',
    });
    // 2 months * 1 call each = 2
    expect((api.callFlatApi as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    const firstCall = (api.callFlatApi as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCall.params.Granularity).toBe('DAY');
  });
});

describe('BillingService.getSettleBillSummary', () => {
  it('issues ListSettleBillTotalSummary with compact cycle dates', async () => {
    const api = makeMockApiClient({
      flat: async (opts) => {
        expect(opts.action).toBe('ListSettleBillTotalSummary');
        expect(opts.params).toMatchObject({
          StartBillingCycle: '202606',
          EndBillingCycle: '202606',
        });
        return {};
      },
    });
    const svc = new BillingService(api, stubBillingAdapter, makeMockCachedFetcher());
    const out = await svc.getSettleBillSummary({
      from: '2026-06',
      to: '2026-06',
    });
    expect(out.period).toEqual({ from: '2026-06', to: '2026-06' });
    expect(out.currency).toBeDefined();
  });
});

// SKIP_LINE_ITEM_CATEGORIES export validation

describe('SKIP_LINE_ITEM_CATEGORIES', () => {
  it('contains the three expected skip labels', () => {
    expect(SKIP_LINE_ITEM_CATEGORIES.has('Rounding Adjustment')).toBe(true);
    expect(SKIP_LINE_ITEM_CATEGORIES.has('Refund')).toBe(true);
    expect(SKIP_LINE_ITEM_CATEGORIES.has('Credit Adjustment')).toBe(true);
  });
});
