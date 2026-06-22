/**
 * Tests for the billing adapter — pure transformations from raw flat-parameter
 * responses into Service-layer DTOs. The adapter is fully synchronous and has
 * no side effects, so these tests focus on:
 *   - field mapping precision (StepQuantityUnit → billingUnit, BillQuantity → usageValue)
 *   - fallback chains (RequireAmount → Amount → Cost → ListPrice)
 *   - boundary semantics (empty list, missing fields, NaN guards, percentage clamping)
 *   - currency resolution against site.features.currency (CNY)
 */
import { describe, it, expect } from 'vitest';
import {
  transformConsumeSummary,
  transformFqInstances,
  transformFrInstances,
  transformUsageLimit,
  transformConsumeBreakdown,
  transformCostAnalysis,
  transformSettleBillSummary,
} from '../../../src/api/adapters/billing-adapter.js';
import type {
  ConsumeSummaryResponse,
  FqInstanceResponse,
  FrInstanceResponse,
} from '../../../src/types/api-models.js';

// ────────────────────────────────────────────────────────────────────
// transformConsumeSummary
// ────────────────────────────────────────────────────────────────────

describe('transformConsumeSummary', () => {
  it('maps a token-based item with the 1K step expansion', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [
        {
          LineItemCategory: 'LLM Token Consumption',
          BillingItemCode: 'token_number',
          BillingDate: '2026-05-30',
          BillingMonth: '2026-05',
          ModelName: 'qwen-plus',
          BillQuantity: 12.5,
          StepQuantityUnit: '1K tokens',
          RequireAmount: 0.875,
        },
      ],
    };
    const out = transformConsumeSummary(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      lineItemCat: 'LLM Token Consumption',
      billingDate: '2026-05-30',
      billingMonth: '2026-05',
      modelId: 'qwen-plus',
      usageValue: 12500,
      cost: 0.875,
      billingUnit: '1K tokens',
      isFree: false,
    });
  });

  it('flags free tier items via the "Free" substring rule', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [
        {
          LineItemCategory: 'Free Tier Image Generation',
          BillingItemCode: 'image_number',
          BillingDate: '2026-05-30',
          ModelName: 'wanx2.1',
          BillQuantity: 3,
          StepQuantityUnit: 'images',
          RequireAmount: 0,
        },
      ],
    };
    const out = transformConsumeSummary(raw);
    expect(out[0]?.isFree).toBe(true);
    expect(out[0]?.billingUnit).toBe('images');
    expect(out[0]?.usageValue).toBe(3);
  });

  it('skips items in the SKIP_LINE_ITEM_CATEGORIES set', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [
        {
          LineItemCategory: 'Subscription Activation Free',
          BillingDate: '2026-05-30',
          BillQuantity: 1,
        },
        {
          LineItemCategory: 'LLM Token Consumption',
          BillingDate: '2026-05-30',
          BillQuantity: 1,
          StepQuantityUnit: '1K tokens',
          RequireAmount: 0.05,
          ModelName: 'qwen-plus',
        },
      ],
    };
    const out = transformConsumeSummary(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.modelId).toBe('qwen-plus');
  });

  it('falls back through cost candidates RequireAmount → Amount → Cost → ListPrice', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [
        {
          LineItemCategory: 'X',
          BillingDate: '2026-05-30',
          ModelName: 'm',
          BillQuantity: 1,
          ListPrice: 0.42,
        },
      ],
    };
    const out = transformConsumeSummary(raw);
    expect(out[0]?.cost).toBeCloseTo(0.42);
  });

  it('infers billingMonth from billingDate when BillingMonth is absent', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [
        {
          LineItemCategory: 'X',
          BillingDate: '2026-05-30',
          ModelName: 'm',
          BillQuantity: 1,
          StepQuantityUnit: 'pages',
          RequireAmount: 1,
        },
      ],
    };
    expect(transformConsumeSummary(raw)[0]?.billingMonth).toBe('2026-05');
  });

  it('falls back to "unknown" when no model field is present', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [{ LineItemCategory: 'X', BillingDate: '2026-05-30', BillQuantity: 1 }],
    };
    expect(transformConsumeSummary(raw)[0]?.modelId).toBe('unknown');
  });

  it('expands the 1M step variant', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [
        {
          LineItemCategory: 'X',
          BillingDate: '2026-05-30',
          ModelName: 'm',
          BillQuantity: 2,
          StepQuantityUnit: 'Per 1M tokens',
          RequireAmount: 0.07,
        },
      ],
    };
    expect(transformConsumeSummary(raw)[0]?.usageValue).toBe(2_000_000);
  });

  it('falls back to BillingItemCode-derived units when StepQuantityUnit is empty', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [
        {
          LineItemCategory: 'X',
          BillingDate: '2026-05-30',
          ModelName: 'm',
          BillQuantity: 5,
          StepQuantityUnit: '',
          BillingItemCode: 'video_duration',
          RequireAmount: 0.5,
        },
      ],
    };
    expect(transformConsumeSummary(raw)[0]?.billingUnit).toBe('seconds');
  });

  it('returns an empty array for a missing Data field', () => {
    expect(transformConsumeSummary({} as ConsumeSummaryResponse)).toEqual([]);
  });

  it('treats non-numeric BillQuantity strings as 0', () => {
    const raw: ConsumeSummaryResponse = {
      Data: [
        {
          LineItemCategory: 'X',
          BillingDate: '2026-05-30',
          ModelName: 'm',
          BillQuantity: 'not-a-number' as unknown as number,
          StepQuantityUnit: '1K tokens',
        },
      ],
    };
    expect(transformConsumeSummary(raw)[0]?.usageValue).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// transformFqInstances
// ────────────────────────────────────────────────────────────────────

describe('transformFqInstances', () => {
  it('maps a single instance with computed used percentage', () => {
    const raw: FqInstanceResponse = {
      TotalCount: 1,
      PageSize: 10,
      RequestId: 'req-1',
      CurrentPage: 1,
      Data: [
        {
          InstanceName: 'fq-1',
          Status: 'VALID',
          Uid: 1,
          InitCapacity: { BaseValue: 1000, ShowUnit: 'tokens', ShowValue: '1K' },
          CurrCapacity: { BaseValue: 250, ShowUnit: 'tokens', ShowValue: '250' },
          Template: { Code: 'qwen-free', Name: 'Qwen Free Tier' },
          StartTime: '2026-01-01',
          EndTime: '2026-12-31',
          CurrentCycleStartTime: '2026-05-01',
          CurrentCycleEndTime: '2026-05-31',
        },
      ],
    };
    const out = transformFqInstances(raw);
    expect(out).toEqual([
      {
        total: 1000,
        remaining: 250,
        usedPct: 75,
        templateCode: 'qwen-free',
        templateName: 'Qwen Free Tier',
        status: 'valid',
        cycleStart: '2026-05-01',
        cycleEnd: '2026-05-31',
      },
    ]);
  });

  it('clamps used percentage at 100 when remaining > total is impossible (defensive)', () => {
    const raw: FqInstanceResponse = {
      TotalCount: 1,
      PageSize: 10,
      RequestId: 'req-1',
      CurrentPage: 1,
      Data: [
        {
          InstanceName: 'fq-1',
          Status: '',
          Uid: 1,
          InitCapacity: { BaseValue: 100, ShowUnit: '', ShowValue: '' },
          CurrCapacity: { BaseValue: 200, ShowUnit: '', ShowValue: '' },
          Template: { Code: '', Name: '' },
          StartTime: '',
          EndTime: '',
          CurrentCycleStartTime: '',
          CurrentCycleEndTime: '',
        },
      ],
    };
    expect(transformFqInstances(raw)[0]?.usedPct).toBe(0);
  });

  it('returns 0% when total is zero', () => {
    const raw: FqInstanceResponse = {
      TotalCount: 0,
      PageSize: 10,
      RequestId: 'req-1',
      CurrentPage: 1,
      Data: [
        {
          InstanceName: 'fq-1',
          Status: 'expired',
          Uid: 1,
          InitCapacity: { BaseValue: 0, ShowUnit: '', ShowValue: '' },
          CurrCapacity: { BaseValue: 0, ShowUnit: '', ShowValue: '' },
          Template: { Code: 'tpl', Name: 'tpl name' },
          StartTime: '',
          EndTime: '',
          CurrentCycleStartTime: '',
          CurrentCycleEndTime: '',
        },
      ],
    };
    expect(transformFqInstances(raw)[0]?.usedPct).toBe(0);
  });

  it('returns an empty array when Data is missing', () => {
    expect(transformFqInstances({} as FqInstanceResponse)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// transformFrInstances
// ────────────────────────────────────────────────────────────────────

describe('transformFrInstances', () => {
  it('returns the unsubscribed default when Data is empty', () => {
    expect(transformFrInstances({ Data: [] })).toEqual({
      subscribed: false,
      totalCredits: 0,
      remainingCredits: 0,
      usedPct: 0,
      planName: '',
      status: '',
    });
  });

  it('maps the primary item, preferring CommodityName then TemplateName', () => {
    const raw: FrInstanceResponse = {
      Data: [
        {
          InstanceId: 'fr-1',
          CommodityCode: 'token-plan-team',
          CommodityName: 'Token Plan Team Edition',
          Status: { Code: 'valid', Name: 'Valid' },
          InitCapacityBaseValue: '5000000',
          CurrCapacityBaseValue: '4500000',
          EndTime: 1762012800000,
          EnableRenew: true,
        },
      ],
    };
    const out = transformFrInstances(raw);
    expect(out).toEqual({
      subscribed: true,
      totalCredits: 5000000,
      remainingCredits: 4500000,
      usedPct: 10,
      planName: 'Token Plan Team Edition',
      status: 'valid',
      endTime: 1762012800000,
      enableRenew: true,
    });
  });

  it('falls back to TemplateName and treats string Status verbatim', () => {
    const raw: FrInstanceResponse = {
      Data: [
        {
          InstanceId: 'fr-1',
          CommodityCode: 'c',
          TemplateName: 'Token Plan Personal',
          Status: 'EXPIRED',
          InitCapacityBaseValue: '0',
          CurrCapacityBaseValue: '0',
        },
      ],
    };
    const out = transformFrInstances(raw);
    expect(out.planName).toBe('Token Plan Personal');
    expect(out.status).toBe('expired');
  });

  it('reports addonRemaining from a second item when present', () => {
    const raw: FrInstanceResponse = {
      Data: [
        {
          InstanceId: 'fr-primary',
          CommodityCode: 'c',
          Status: 'valid',
          InitCapacityBaseValue: '1000',
          CurrCapacityBaseValue: '500',
        },
        {
          InstanceId: 'fr-addon',
          CommodityCode: 'c-addon',
          Status: 'valid',
          InitCapacityBaseValue: '2000',
          CurrCapacityBaseValue: '777',
        },
      ],
    };
    expect(transformFrInstances(raw).addonRemaining).toBe(777);
  });

  it('omits optional fields when absent on the primary item', () => {
    const raw: FrInstanceResponse = {
      Data: [
        {
          InstanceId: 'fr-1',
          CommodityCode: 'c',
          Status: 'valid',
          InitCapacityBaseValue: '100',
          CurrCapacityBaseValue: '50',
        },
      ],
    };
    const out = transformFrInstances(raw);
    expect(out).not.toHaveProperty('endTime');
    expect(out).not.toHaveProperty('enableRenew');
  });
});

// ────────────────────────────────────────────────────────────────────
// transformUsageLimit
// ────────────────────────────────────────────────────────────────────

describe('transformUsageLimit', () => {
  it('returns "unknown" status defaults when raw is null/undefined', () => {
    expect(transformUsageLimit(null)).toEqual({
      status: 'unknown',
      limitAmount: null,
      currency: 'CNY',
      alertThreshold: '0',
    });
    expect(transformUsageLimit(undefined)).toEqual({
      status: 'unknown',
      limitAmount: null,
      currency: 'CNY',
      alertThreshold: '0',
    });
  });

  it('preserves limit amount as a string and resolves currency from raw', () => {
    expect(
      transformUsageLimit({
        Status: 'active',
        LimitAmount: '888.50',
        Currency: 'USD',
        AlertThreshold: '80',
        Receivers: ['ops@test.qianwen.com', 'oncall@test.qianwen.com'],
      }),
    ).toEqual({
      status: 'active',
      limitAmount: '888.50',
      currency: 'USD',
      alertThreshold: '80',
    });
  });

  it('falls back to site currency when raw currency is missing or empty', () => {
    expect(transformUsageLimit({ Status: 'active', LimitAmount: 100 }).currency).toBe('CNY');
    expect(transformUsageLimit({ Status: 'active', Currency: '' }).currency).toBe('CNY');
  });

  it('coerces numeric LimitAmount to a decimal string', () => {
    expect(transformUsageLimit({ Status: 'active', LimitAmount: 1234.5 }).limitAmount).toBe(
      '1234.5',
    );
  });

  it('treats empty string LimitAmount and AlertThreshold as null/"0"', () => {
    const out = transformUsageLimit({ Status: 'active', LimitAmount: '', AlertThreshold: '' });
    expect(out.limitAmount).toBeNull();
    expect(out.alertThreshold).toBe('0');
  });

  it('handles a missing Receivers field gracefully', () => {
    const dto = transformUsageLimit({ Status: 'active', LimitAmount: 100, Receivers: undefined });
    expect(dto.status).toBe('active');
  });
});

// ────────────────────────────────────────────────────────────────────
// transformConsumeBreakdown
// ────────────────────────────────────────────────────────────────────

describe('transformConsumeBreakdown', () => {
  it('returns an empty rows array when raw is missing', () => {
    expect(transformConsumeBreakdown(null)).toEqual({ rows: [] });
    expect(transformConsumeBreakdown({})).toEqual({ rows: [] });
  });

  it('maps GroupByTotal entries verbatim, defaulting Name to Key', () => {
    expect(
      transformConsumeBreakdown({
        GroupByTotal: [
          { Key: 'qwen-plus', Name: 'Qwen Plus', Amount: '12.34' },
          { Key: 'qwen-turbo', Amount: 5.5 },
          { Key: 'unknown', Amount: '' },
        ],
      }),
    ).toEqual({
      rows: [
        { groupKey: 'qwen-plus', groupLabel: 'Qwen Plus', amount: '12.34' },
        { groupKey: 'qwen-turbo', groupLabel: 'qwen-turbo', amount: '5.5' },
        { groupKey: 'unknown', groupLabel: 'unknown', amount: '0' },
      ],
    });
  });

  it('handles a non-array GroupByTotal field gracefully', () => {
    expect(transformConsumeBreakdown({ GroupByTotal: 'not-an-array' })).toEqual({ rows: [] });
  });
});

// ────────────────────────────────────────────────────────────────────
// transformCostAnalysis
// ────────────────────────────────────────────────────────────────────

describe('transformCostAnalysis', () => {
  it('prefers ResultByTime over Items when both are present', () => {
    expect(
      transformCostAnalysis({
        ResultByTime: [
          { Period: '2026-05-29', Total: { Amount: '1.50', Currency: 'USD' } },
          { Period: '2026-05-30', Total: { Amount: 2.75 } },
        ],
        Items: [{ Period: '2026-04-01', Amount: '999' }],
        Granularity: 'day',
        CostTotals: { Currency: 'USD' },
      }),
    ).toEqual({
      items: [
        { period: '2026-05-29', amount: '1.50' },
        { period: '2026-05-30', amount: '2.75' },
      ],
      granularity: 'day',
      currency: 'USD',
    });
  });

  it('falls back to Items when ResultByTime is missing or empty', () => {
    const out = transformCostAnalysis({
      Items: [{ Period: '2026-05', Amount: '100' }],
      Granularity: 'month',
      Currency: 'EUR',
    });
    expect(out.items).toEqual([{ period: '2026-05', amount: '100' }]);
    expect(out.granularity).toBe('month');
    expect(out.currency).toBe('EUR');
  });

  it('returns empty items and "day" granularity when both sources are absent', () => {
    expect(transformCostAnalysis({})).toEqual({ items: [], granularity: 'day', currency: 'CNY' });
  });

  it('handles missing Total.Amount inside a ResultByTime entry', () => {
    const out = transformCostAnalysis({
      ResultByTime: [{ Period: '2026-05-30', Total: {} }],
    });
    expect(out.items).toEqual([{ period: '2026-05-30', amount: '0' }]);
  });

  it('expands PeriodDetails into per-group items when grouped', () => {
    const out = transformCostAnalysis({
      ResultByTime: [
        {
          Period: '2026-06-01',
          Total: { Amount: '3.00' },
          PeriodDetails: [
            { Key: 'ws-1', Name: 'Workspace A', Amount: '2.00' },
            { Key: 'ws-2', Name: 'Workspace B', Amount: '1.00' },
          ],
        },
      ],
      Granularity: 'day',
    });
    expect(out.items).toEqual([
      { period: '2026-06-01', amount: '2.00', groupKey: 'ws-1', groupLabel: 'Workspace A' },
      { period: '2026-06-01', amount: '1.00', groupKey: 'ws-2', groupLabel: 'Workspace B' },
    ]);
  });

  it('falls back groupLabel to groupKey when Name is missing in PeriodDetails', () => {
    const out = transformCostAnalysis({
      ResultByTime: [
        { Period: '2026-06-01', PeriodDetails: [{ Key: 'ws-9999', Amount: '1.00' }] },
      ],
    });
    expect(out.items).toEqual([
      { period: '2026-06-01', amount: '1.00', groupKey: 'ws-9999', groupLabel: 'ws-9999' },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────
// transformSettleBillSummary
// ────────────────────────────────────────────────────────────────────

describe('transformSettleBillSummary', () => {
  it('returns an empty cycles array when raw is null', () => {
    expect(transformSettleBillSummary(null)).toEqual({ cycles: [], currency: 'CNY' });
  });

  it('maps each cycle with the documented field-fallback chain', () => {
    expect(
      transformSettleBillSummary({
        Data: [
          {
            BillingCycle: '2026-04',
            TotalPriceSettleFee: '100.00',
            TotalPriceTaxFee: '6.50',
            TotalPricePostTaxFee: '106.50',
            Discount: '10',
            PaidAmount: '96.50',
            OutstandingAmount: '0',
            Currency: 'USD',
          },
          {
            BillingCycle: '2026-05',
            PretaxAmount: '50',
            Tax: '3',
            AftertaxAmount: '53',
          },
        ],
      }),
    ).toEqual({
      cycles: [
        {
          billingCycle: '2026-04',
          pretaxAmount: '100.00',
          tax: '6.50',
          aftertaxAmount: '106.50',
        },
        {
          billingCycle: '2026-05',
          pretaxAmount: '50',
          tax: '3',
          aftertaxAmount: '53',
        },
      ],
      // Top-level Currency missing → fall back to first item Currency.
      currency: 'USD',
    });
  });

  it('falls back to site currency when neither top-level nor item currency is present', () => {
    expect(
      transformSettleBillSummary({
        Data: [
          {
            BillingCycle: '2026-05',
            PretaxAmount: '0',
          },
        ],
      }).currency,
    ).toBe('CNY');
  });

  it('treats a non-array Data field as empty cycles', () => {
    expect(transformSettleBillSummary({ Data: 'not-an-array', Currency: 'USD' })).toEqual({
      cycles: [],
      currency: 'USD',
    });
  });
});
