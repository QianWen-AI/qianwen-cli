/** Pay-as-you-go orchestration and billing-rule utilities. */

import type { ApiClient } from '../api/api-client.js';
import type { CachedFetcher } from '../types/cache.js';
import type {
  ConsumeSummaryLineItem,
  DescribeUsageLimitResponse,
  MaasDescribeCostAnalysisResponse,
  ListSettleBillTotalSummaryResponse,
} from '../types/api-models.js';
import type {
  PayAsYouGo,
  UsageBreakdownResponse,
  UsageBreakdownRow,
  UsageBreakdownTotal,
} from '../types/usage.js';
import type {
  UsageLimit,
  ConsumeBreakdown,
  ConsumeBreakdownByPeriods,
  ConsumeBreakdownDto,
  ConsumeBreakdownOptions,
  ConsumeBreakdownPeriodSlice,
  ConsumeBreakdownRow,
  SettleBillCycle,
  SettleBillSummary,
  SettleBillSummaryDto,
  SettleBillSummaryOptions,
  SettleBillTotals,
} from '../types/billing-extra.js';
import type { GetFundAccountAvailableAmountResponse, BalanceSummaryDto } from '../types/balance.js';
import {
  transformUsageLimit,
  transformConsumeBreakdown,
  transformSettleBillSummary,
  transformBalanceSummary,
} from '../api/adapters/billing-adapter.js';
import {
  aggregatePaygByModel,
  aggregatePaygByDate,
  aggregateMonthly,
  aggregateQuarterly,
  fillDailyGaps,
  mergePaygModelData,
  type PaygItem,
  type PaygDailyRow,
  type AggregatedRow,
} from '../utils/payg-aggregator.js';
import { site } from '../site.js';
import { sumAmountStrings, subtractAmountStrings, toDecimalString } from '../utils/amount.js';
import { normalizeToFullDate } from '../utils/date.js';

// Re-export: historical import site for the amount summation helper (now
// shared from utils so the aggregators can use it without a services dep).
export { sumAmountStrings } from '../utils/amount.js';

const API_PRODUCT_BSS = 'BssOpenAPI-V3';
const API_ACTION_CONSUME_SUMMARY = 'MaasListConsumeSummary';
const BREAKDOWN_CACHE_TTL_MS = 30 * 1000;

function toCompactCycle(cycle: string): string {
  return cycle.replace(/-/g, '');
}

function toCompactDate(date: string): string {
  return date.replace(/-/g, '');
}

const DIM_FIELD_MAP: Record<string, string> = {
  model: 'BASE_MODEL',
  'api-key': 'API_KEY_ID',
};

function toNumber(value: string | number | undefined | null): number {
  if (value == null) return 0;
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return Number.isFinite(n) ? n : 0;
}

export const SKIP_LINE_ITEM_CATEGORIES: ReadonlySet<string> = new Set([
  'Rounding Adjustment',
  'Refund',
  'Credit Adjustment',
]);

/** Infer the billing unit. */
export function inferBillingUnit(stepUnit: string, billingItemCode?: string): string {
  if (billingItemCode) {
    const codeLower = billingItemCode.toLowerCase();
    if (codeLower.includes('image')) return 'images';
    if (codeLower.includes('video') || codeLower.includes('duration')) return 'seconds';
    if (codeLower.includes('char')) return 'characters';
    if (codeLower.includes('voice')) return 'voices';
    if (codeLower.includes('token')) return 'tokens';
  }

  if (stepUnit) {
    const unitLower = stepUnit.toLowerCase();
    if (unitLower.includes('token')) return 'tokens';
    if (unitLower.includes('image') || unitLower.includes('page')) return 'images';
    if (unitLower.includes('second') || unitLower.includes('sec')) return 'seconds';
    if (unitLower.includes('char') || unitLower.includes('word')) return 'characters';
    if (unitLower.includes('voice')) return 'voices';
  }

  const perMatch = stepUnit.match(/^Per\s+\S+\s+(.+)$/i);
  if (perMatch) return perMatch[1]!.toLowerCase();

  return 'tokens';
}

/** Convert BillQuantity × step size to raw units. */
export function computeUsageValue(billQuantity: number, stepUnit: string): number {
  if (billQuantity === 0) return 0;
  const unitLower = stepUnit.toLowerCase();

  if (unitLower.includes('tenthousand') || stepUnit.includes('万字')) {
    return billQuantity * 10_000;
  }

  const numMatch = stepUnit.match(/(?:^|Per\s+)([\d,]+)\s*([KMkm])?/);
  if (numMatch) {
    const rawNum = numMatch[1]!.replace(/,/g, '');
    const num = parseInt(rawNum, 10);
    const suffix = (numMatch[2] ?? '').toUpperCase();

    let multiplier = num;
    if (suffix === 'K') multiplier = num * 1_000;
    else if (suffix === 'M') multiplier = num * 1_000_000;

    if (multiplier === 1) return billQuantity;
    return billQuantity * multiplier;
  }

  return billQuantity;
}

export interface ParsedBillingItem {
  lineItemCat: string;
  billingDate: string;
  billingMonth: string;
  modelId: string;
  usageValue: number;
  cost: number;
  billingUnit: string;
  isFree: boolean;
}

/** Parse a line item into normalized fields. Returns null for skip categories. */
export function parseBillingItem(
  item: ConsumeSummaryLineItem,
  costMode?: 'full' | 'minimal',
): ParsedBillingItem | null {
  const category = item.LineItemCategory ?? '';
  if (SKIP_LINE_ITEM_CATEGORIES.has(category)) return null;

  const mode = costMode ?? 'full';
  const billingDate = item.BillingDate ?? '';
  const billingMonth = item.BillingMonth ?? '';
  const modelId = item.ModelName ?? item.Model ?? item.JobId ?? item.MaasTypeName ?? 'Other';
  const billQuantity = toNumber(item.BillQuantity);
  const stepUnit = item.StepQuantityUnit ?? '';
  const billingItemCode = item.BillingItemCode ?? '';

  const usageValue = computeUsageValue(billQuantity, stepUnit);
  const billingUnit = inferBillingUnit(stepUnit, billingItemCode);

  const cost =
    mode === 'full'
      ? toNumber(item.RequireAmount ?? item.Amount ?? item.Cost ?? item.ListPrice)
      : toNumber(item.RequireAmount ?? item.ListPrice);

  const isFree = category.toLowerCase().includes('free');

  return {
    lineItemCat: category,
    billingDate,
    billingMonth,
    modelId,
    usageValue,
    cost,
    billingUnit,
    isFree,
  };
}

/** Split [fromDate, toDate] into per-calendar-month sub-ranges. */
export function splitIntoMonths(fromDate: string, toDate: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  let current = fromDate;

  while (current <= toDate) {
    const [yearStr, monthStr] = current.split('-') as [string, string];
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const lastDayOfMonth = new Date(year, month, 0).getDate();
    const monthEnd = `${yearStr}-${monthStr}-${String(lastDayOfMonth).padStart(2, '0')}`;

    if (monthEnd >= toDate) {
      result.push([current, toDate]);
      break;
    } else {
      result.push([current, monthEnd]);
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      current = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
    }
  }

  return result;
}

export interface BillingAdapter {
  toNormalizedItem(item: ConsumeSummaryLineItem): ParsedBillingItem | null;
}

export interface PaygSummaryOptions {
  from: string;
  to: string;
}

export interface PaygBreakdownOptions {
  from: string;
  to: string;
  granularity: 'day' | 'month' | 'quarter';
  modelFilter?: string;
}

interface RawConsumeData {
  Data?: ConsumeSummaryLineItem[];
}

export class BillingService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly billingAdapter: BillingAdapter,
    private readonly cache: CachedFetcher,
  ) {}

  async getUsageLimit(): Promise<UsageLimit> {
    const raw = await this.apiClient.callFlatApi<DescribeUsageLimitResponse>({
      product: API_PRODUCT_BSS,
      action: 'DescribeUsageLimit',
    });
    return transformUsageLimit(raw);
  }

  async getAvailableBalance(): Promise<BalanceSummaryDto> {
    const raw = await this.apiClient.callFlatApi<GetFundAccountAvailableAmountResponse>({
      product: API_PRODUCT_BSS,
      action: 'GetFundAccountAvailableAmount',
      params: {},
    });
    return transformBalanceSummary(raw);
  }

  /** Break down PAYG spend along a user-selected dimension.
   *  - MONTH granularity: single API call with YYYYMM compact dates.
   *  - DAY granularity: single call when span ≤ 30 days; otherwise sliced
   *    into per-calendar-month sub-ranges so that months with no data do not
   *    cause the API to blank out the entire response.
   *  Always excludes TaxFee via Filter (domestic site does not display tax).
   *  All rows returned by the API (including server-side Others) are preserved. */
  async getConsumeBreakdown(opts: ConsumeBreakdownOptions): Promise<ConsumeBreakdown> {
    const dimCode = DIM_FIELD_MAP[opts.groupBy] ?? 'BASE_MODEL';
    const chargeTypes = opts.chargeType && opts.chargeType !== 'all' ? [opts.chargeType] : [];
    const topNum = opts.top > 0 ? opts.top : 10;
    const granularity = opts.granularity ?? 'month';

    const filter = {
      Dimensions: [{ Code: 'LINE_ITEM_CATEGORY', Values: ['TaxFee'], SelectType: 'NOT' }],
    };

    const mergedMap = new Map<string, ConsumeBreakdownRow>();
    let apiTotalAmount = '';

    if (granularity === 'month') {
      const startDate = toCompactCycle(opts.from.substring(0, 7));
      const endDate = toCompactCycle(opts.to.substring(0, 7));
      const cacheKey = `breakdown:${opts.groupBy}:${startDate}:${endDate}:${opts.chargeType}:month`;

      const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
        this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
          product: API_PRODUCT_BSS,
          action: 'MaasDescribeCostAnalysis',
          params: {
            BizType: 'MAAS_CONSUME_ANALYSIS',
            ChargeTypes: chargeTypes,
            Granularity: 'MONTH',
            TimePeriod: { Start: startDate, End: endDate },
            TopNum: topNum,
            GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
            Filter: filter,
          },
        }),
      );

      const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
      for (const row of dto.rows) {
        mergedMap.set(row.groupKey, { ...row });
      }
      if (dto.totalAmount) apiTotalAmount = dto.totalAmount;
    } else {
      const fromDate = normalizeToFullDate(opts.from, 'start');
      const toDate = normalizeToFullDate(opts.to, 'end');

      const spanDays = this.daysBetween(fromDate, toDate);
      const apiTotalParts: string[] = [];

      if (spanDays <= 30) {
        const cacheKey = `breakdown:${opts.groupBy}:${fromDate}:${toDate}:${opts.chargeType}`;

        const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
          this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
            product: API_PRODUCT_BSS,
            action: 'MaasDescribeCostAnalysis',
            params: {
              BizType: 'MAAS_CONSUME_ANALYSIS',
              ChargeTypes: chargeTypes,
              Granularity: 'DAY',
              TimePeriod: {
                Start: toCompactDate(fromDate),
                End: toCompactDate(toDate),
              },
              TopNum: topNum,
              GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
              Filter: filter,
            },
          }),
        );

        const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
        for (const row of dto.rows) {
          mergedMap.set(row.groupKey, { ...row });
        }
        if (dto.totalAmount) apiTotalParts.push(dto.totalAmount);
      } else {
        const months = splitIntoMonths(fromDate, toDate);

        for (const [monthStart, monthEnd] of months) {
          const cacheKey = `breakdown:${opts.groupBy}:${monthStart}:${monthEnd}:${opts.chargeType}`;

          const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
            this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
              product: API_PRODUCT_BSS,
              action: 'MaasDescribeCostAnalysis',
              params: {
                BizType: 'MAAS_CONSUME_ANALYSIS',
                ChargeTypes: chargeTypes,
                Granularity: 'DAY',
                TimePeriod: {
                  Start: toCompactDate(monthStart),
                  End: toCompactDate(monthEnd),
                },
                TopNum: topNum,
                GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
                Filter: filter,
              },
            }),
          );

          const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
          for (const row of dto.rows) {
            const existing = mergedMap.get(row.groupKey);
            if (existing) {
              existing.amount = sumAmountStrings([existing.amount, row.amount]);
            } else {
              mergedMap.set(row.groupKey, { ...row });
            }
          }
          if (dto.totalAmount) apiTotalParts.push(dto.totalAmount);
        }
      }

      if (apiTotalParts.length > 0) {
        apiTotalAmount = sumAmountStrings(apiTotalParts);
      }
    }

    const allRows = [...mergedMap.values()];
    const totalRows = allRows.length;
    const sortedRows = allRows.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const truncatedRows = sortedRows.slice(0, topNum);

    const displayedSum = sumAmountStrings(truncatedRows.map((r) => r.amount));
    const totalAmount = apiTotalAmount || displayedSum;

    if (totalAmount && parseFloat(totalAmount) > parseFloat(displayedSum)) {
      const unlistedAmount = subtractAmountStrings(totalAmount, displayedSum);
      if (parseFloat(unlistedAmount) > 0) {
        truncatedRows.push({
          groupKey: 'UNLISTED',
          groupLabel: 'Unlisted',
          amount: unlistedAmount,
        });
      }
    }

    return {
      groupBy: opts.groupBy,
      period: { from: opts.from, to: opts.to },
      chargeType: opts.chargeType,
      rows: truncatedRows,
      totalRows,
      totalAmount,
      currency: site.features.currency,
    };
  }

  /** Break down PAYG spend into per-period slices without cross-period aggregation.
   *  Each slice contains its own top-N rows.
   *  Always excludes TaxFee via Filter (domestic site does not display tax). */
  async getConsumeBreakdownByPeriods(
    opts: ConsumeBreakdownOptions,
  ): Promise<ConsumeBreakdownByPeriods> {
    const dimCode = DIM_FIELD_MAP[opts.groupBy] ?? 'BASE_MODEL';
    const chargeTypes = opts.chargeType && opts.chargeType !== 'all' ? [opts.chargeType] : [];
    const topNum = opts.top > 0 ? opts.top : 10;
    const granularity = opts.granularity ?? 'month';

    const filter = {
      Dimensions: [{ Code: 'LINE_ITEM_CATEGORY', Values: ['TaxFee'], SelectType: 'NOT' }],
    };

    const slices: ConsumeBreakdownPeriodSlice[] = [];

    if (granularity === 'month') {
      const fromMonth = opts.from.substring(0, 7);
      const toMonth = opts.to.substring(0, 7);
      const startDate = toCompactCycle(fromMonth);
      const endDate = toCompactCycle(toMonth);
      const cacheKey = `breakdown-periods:${opts.groupBy}:${startDate}:${endDate}:${opts.chargeType}:month`;

      const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
        this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
          product: API_PRODUCT_BSS,
          action: 'MaasDescribeCostAnalysis',
          params: {
            BizType: 'MAAS_CONSUME_ANALYSIS',
            ChargeTypes: chargeTypes,
            Granularity: 'MONTH',
            TimePeriod: { Start: startDate, End: endDate },
            TopNum: topNum,
            GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
            Filter: filter,
          },
        }),
      );

      const resultByTime = raw?.ResultByTime;

      if (resultByTime && resultByTime.length > 0) {
        for (const entry of resultByTime) {
          const period = entry.Period ?? '';
          const totalAmount = this.toAmountStr(entry.Total?.Amount);
          const rows = (entry.PeriodDetails ?? []).map((item) => ({
            groupKey: item.Key ?? '',
            groupLabel: item.Name ?? item.Key ?? '',
            amount: this.toAmountStr(item.Amount),
          }));
          const slice = this.buildPeriodSliceFromRows(period, rows, topNum, totalAmount);
          slices.push(slice);
        }
      } else {
        // Fallback: read from GroupByTotal when ResultByTime is absent
        const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
        const periodLabel = fromMonth === toMonth ? fromMonth : `${fromMonth} \u2192 ${toMonth}`;
        const slice = this.buildPeriodSliceFromRows(periodLabel, dto.rows, topNum, dto.totalAmount);
        slices.push(slice);
      }
    } else {
      const fromDate = normalizeToFullDate(opts.from, 'start');
      const toDate = normalizeToFullDate(opts.to, 'end');
      const spanDays = this.daysBetween(fromDate, toDate);

      const fetchAndParseDaySlices = async (start: string, end: string) => {
        const cacheKey = `breakdown-periods:${opts.groupBy}:${start}:${end}:${opts.chargeType}:day`;

        const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
          this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
            product: API_PRODUCT_BSS,
            action: 'MaasDescribeCostAnalysis',
            params: {
              BizType: 'MAAS_CONSUME_ANALYSIS',
              ChargeTypes: chargeTypes,
              Granularity: 'DAY',
              TimePeriod: {
                Start: toCompactDate(start),
                End: toCompactDate(end),
              },
              TopNum: topNum,
              GroupBy: [{ Code: dimCode, Type: 'Dimensions' }],
              Filter: filter,
            },
          }),
        );

        const resultByTime = raw?.ResultByTime;

        if (resultByTime && resultByTime.length > 0) {
          for (const entry of resultByTime) {
            const period = entry.Period ?? start;
            const rows = (entry.PeriodDetails ?? []).map((item) => ({
              groupKey: item.Key ?? '',
              groupLabel: item.Name ?? item.Key ?? '',
              amount: this.toAmountStr(item.Amount),
            }));
            const slice = this.buildPeriodSliceFromRows(period, rows, topNum);
            slices.push(slice);
          }
        } else {
          const periodLabel = start === end ? start : `${start} \u2192 ${end}`;
          const slice = this.buildPeriodSlice(periodLabel, raw, topNum);
          slices.push(slice);
        }
      };

      if (spanDays <= 30) {
        await fetchAndParseDaySlices(fromDate, toDate);
      } else {
        const months = splitIntoMonths(fromDate, toDate);
        for (const [monthStart, monthEnd] of months) {
          await fetchAndParseDaySlices(monthStart, monthEnd);
        }
      }
    }

    slices.sort((a, b) => a.period.localeCompare(b.period));

    return {
      groupBy: opts.groupBy,
      dateRange: { from: opts.from, to: opts.to },
      granularity,
      chargeType: opts.chargeType,
      slices,
      currency: site.features.currency,
    };
  }

  private enumerateMonths(fromYM: string, toYM: string): string[] {
    const result: string[] = [];
    let [year, month] = fromYM.split('-').map(Number) as [number, number];
    const [endYear, endMonth] = toYM.split('-').map(Number) as [number, number];
    while (year < endYear || (year === endYear && month <= endMonth)) {
      result.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
    return result;
  }

  private buildPeriodSlice(
    period: string,
    raw: MaasDescribeCostAnalysisResponse | null | undefined,
    topNum: number,
  ): ConsumeBreakdownPeriodSlice {
    const dto: ConsumeBreakdownDto = transformConsumeBreakdown(raw);
    return this.buildPeriodSliceFromRows(period, dto.rows, topNum, dto.totalAmount);
  }

  private buildPeriodSliceFromRows(
    period: string,
    rows: ConsumeBreakdownRow[],
    topNum: number,
    apiTotalAmount?: string,
  ): ConsumeBreakdownPeriodSlice {
    const sorted = rows.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const truncated = sorted.slice(0, topNum);
    const displayedSum = sumAmountStrings(truncated.map((r) => r.amount));
    const totalAmount = apiTotalAmount || displayedSum;

    if (totalAmount && parseFloat(totalAmount) > parseFloat(displayedSum)) {
      const unlistedAmount = subtractAmountStrings(totalAmount, displayedSum);
      if (parseFloat(unlistedAmount) > 0) {
        truncated.push({ groupKey: 'UNLISTED', groupLabel: 'Unlisted', amount: unlistedAmount });
      }
    }

    return { period, rows: truncated, totalAmount };
  }

  private toAmountStr(value: string | number | undefined | null): string {
    if (value == null) return '0';
    const s = String(value).trim();
    return s.length === 0 ? '0' : s;
  }

  private daysBetween(fromDate: string, toDate: string): number {
    const from = new Date(fromDate);
    const to = new Date(toDate);
    return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  }

  async getSettleBillSummary(opts: SettleBillSummaryOptions): Promise<SettleBillSummary> {
    const raw = await this.apiClient.callFlatApi<ListSettleBillTotalSummaryResponse>({
      product: API_PRODUCT_BSS,
      action: 'ListSettleBillTotalSummary',
      params: {
        StartBillingCycle: toCompactCycle(opts.from),
        EndBillingCycle: toCompactCycle(opts.to),
        ...(opts.chargeType && opts.chargeType !== 'all' ? { ChargeType: opts.chargeType } : {}),
      },
    });
    const dto: SettleBillSummaryDto = transformSettleBillSummary(raw);

    // The server (ListSettleBillTotalSummary) only returns cycles that have a
    // settled bill record, so month gaps appear in the response. Expand the
    // requested [from, to] window into a continuous month list: cycles the
    // server returned keep their real values (a 0 amount is a genuine ¥0.00),
    // while missing months are filled with a placeholder (settled=false) that
    // downstream renderers show as "No bill". Totals only count real records.
    const byCycle = new Map<string, SettleBillCycle>();
    for (const c of dto.cycles) {
      byCycle.set(toCompactCycle(c.billingCycle), c);
    }

    const cycles: SettleBillCycle[] = this.enumerateMonths(opts.from, opts.to).map((ym) => {
      const compact = toCompactCycle(ym);
      const real = byCycle.get(compact);
      if (real) return real;
      return {
        billingCycle: compact,
        pretaxAmount: '0',
        tax: '0',
        aftertaxAmount: '0',
        settled: false,
      };
    });

    const settledCycles = cycles.filter((c) => c.settled);
    const totals: SettleBillTotals = {
      pretaxAmount: sumAmountStrings(settledCycles.map((c) => c.pretaxAmount)),
      tax: sumAmountStrings(settledCycles.map((c) => c.tax)),
      aftertaxAmount: sumAmountStrings(settledCycles.map((c) => c.aftertaxAmount)),
    };
    return {
      cycles,
      totals,
      currency: dto.currency,
      period: { from: opts.from, to: opts.to },
      chargeType: opts.chargeType,
    };
  }

  async getPaygSummary(options: PaygSummaryOptions): Promise<PayAsYouGo> {
    const fromDate = normalizeToFullDate(options.from, 'start');
    const toDate = normalizeToFullDate(options.to, 'end');

    const fromMonth = fromDate.substring(0, 7);
    const toMonth = toDate.substring(0, 7);

    const [items, settleBill, costAnalysis] = await Promise.all([
      this.fetchPaygItems(fromDate, toDate, undefined, 'MONTHLY'),
      this.getSettleBillSummary({ from: fromMonth, to: toMonth, chargeType: 'postpaid' }).catch(
        () => null,
      ),
      this.fetchPaygCostByModel(fromMonth, toMonth).catch(() => null),
    ]);

    // When MaasDescribeCostAnalysis succeeded, use its server-side aggregated
    // per-model costs (no pagination issue) merged with usage data from items.
    // Fall back to the original client-side aggregation otherwise.
    let models: PayAsYouGo['models'];
    let aggregatedTotalCost: number;

    if (costAnalysis && costAnalysis.length > 0) {
      models = mergePaygModelData(costAnalysis, items);
      aggregatedTotalCost = models.reduce((sum, m) => sum + m.cost, 0);
    } else {
      const aggregated = aggregatePaygByModel(items);
      models = aggregated.models;
      aggregatedTotalCost = aggregated.total.cost;
    }

    // Prefer the settlement total when it parses to a finite number — a
    // legitimate 0 (fee waiver / full credit offset / net-zero refund) must
    // not fall back to the aggregated total.
    let settlementTotal = aggregatedTotalCost;
    if (settleBill && settleBill.cycles.some((c) => c.settled)) {
      const parsed = parseFloat(settleBill.totals.aftertaxAmount);
      if (Number.isFinite(parsed)) {
        settlementTotal = parsed;
      }
    }

    return {
      models,
      total: { cost: settlementTotal, currency: site.features.currency },
    };
  }

  async getPaygBreakdown(options: PaygBreakdownOptions): Promise<UsageBreakdownResponse> {
    const fromDate = normalizeToFullDate(options.from, 'start');
    const toDate = normalizeToFullDate(options.to, 'end');
    const items = await this.fetchPaygItems(fromDate, toDate, options.modelFilter);
    const rawDailyRows = aggregatePaygByDate(items);
    const dailyRows = fillDailyGaps(rawDailyRows, fromDate, toDate);

    let rows: AggregatedRow[] | PaygDailyRow[];
    if (options.granularity === 'quarter') {
      rows = aggregateQuarterly(aggregateMonthly(dailyRows));
    } else if (options.granularity === 'month') {
      rows = aggregateMonthly(dailyRows);
    } else {
      rows = dailyRows;
    }

    return this.shapeBreakdown(rows, { ...options, from: fromDate, to: toDate });
  }

  private async fetchPaygItems(
    fromDate: string,
    toDate: string,
    modelFilter?: string,
    granularity: 'DAILY' | 'MONTHLY' = 'DAILY',
  ): Promise<PaygItem[]> {
    const collected: PaygItem[] = [];

    for (const [monthStart, monthEnd] of splitIntoMonths(fromDate, toDate)) {
      const params: Record<string, unknown> =
        granularity === 'MONTHLY'
          ? {
              Console: true,
              Granularity: 'MONTHLY',
              ChargeTypes: ['postpaid'],
              BillingMonth: monthStart.substring(0, 7),
              MaxResults: 100,
              CurrentPage: 1,
            }
          : {
              Console: true,
              Granularity: 'DAILY',
              ChargeTypes: ['postpaid'],
              StartBillingDate: monthStart,
              EndBillingDate: monthEnd,
              MaxResults: 100,
              CurrentPage: 1,
              SortName: 'BillingDate',
              SortOrder: 'DESC',
            };
      if (modelFilter) params['ModelNames'] = [modelFilter];

      const response = await this.apiClient.callFlatApi<RawConsumeData>({
        product: API_PRODUCT_BSS,
        action: API_ACTION_CONSUME_SUMMARY,
        params,
      });

      for (const item of response.Data ?? []) {
        const parsed = this.billingAdapter.toNormalizedItem(item);
        if (!parsed || parsed.isFree) continue;
        collected.push({
          billingDate: parsed.billingDate,
          billingMonth: parsed.billingMonth,
          modelId: parsed.modelId,
          usageValue: parsed.usageValue,
          cost: parsed.cost,
          billingUnit: parsed.billingUnit,
        });
      }
    }

    return collected;
  }

  private async fetchPaygCostByModel(
    fromMonth: string,
    toMonth: string,
  ): Promise<ConsumeBreakdownRow[]> {
    const startDate = toCompactCycle(fromMonth);
    const endDate = toCompactCycle(toMonth);
    const cacheKey = `payg-cost-by-model:${startDate}:${endDate}`;

    const raw = await this.cache.getOrFetch(cacheKey, BREAKDOWN_CACHE_TTL_MS, async () =>
      this.apiClient.callFlatApi<MaasDescribeCostAnalysisResponse>({
        product: API_PRODUCT_BSS,
        action: 'MaasDescribeCostAnalysis',
        params: {
          BizType: 'MAAS_CONSUME_ANALYSIS',
          ChargeTypes: ['postpaid'],
          Granularity: 'MONTH',
          TimePeriod: { Start: startDate, End: endDate },
          TopNum: 20,
          GroupBy: [{ Code: 'BASE_MODEL', Type: 'Dimensions' }],
          Filter: {
            Dimensions: [{ Code: 'LINE_ITEM_CATEGORY', Values: ['TaxFee'], SelectType: 'NOT' }],
          },
        },
      }),
    );

    const dto = transformConsumeBreakdown(raw);
    return dto.rows;
  }

  private shapeBreakdown(
    rows: Array<AggregatedRow | PaygDailyRow>,
    options: PaygBreakdownOptions,
  ): UsageBreakdownResponse {
    const costStrings = rows.map((r) => toDecimalString(r.cost ?? 0));
    const totalCost = parseFloat(sumAmountStrings(costStrings));
    const sumKey = (key: string): number =>
      rows.reduce((s, r) => s + ((r as Record<string, number>)[key] ?? 0), 0);
    const totalTokensIn = sumKey('tokens_in');
    const totalTokensOut = sumKey('tokens_out');
    const totalImages = sumKey('images');
    const totalSeconds = sumKey('seconds');
    const totalCharacters = sumKey('characters');

    const breakdownRows: UsageBreakdownRow[] = rows.map((r) => {
      const out: UsageBreakdownRow = {
        period: r.period,
        cost: r.cost,
        currency: r.currency,
      };
      const flat = r as Record<string, unknown>;
      if (flat.tokens_in != null) out.tokens_in = flat.tokens_in as number;
      if (flat.tokens_out != null) out.tokens_out = flat.tokens_out as number;
      const usage: Record<string, number> = {};
      if (flat.images != null) usage.images = flat.images as number;
      if (flat.seconds != null) usage.seconds = flat.seconds as number;
      if (flat.characters != null) usage.characters = flat.characters as number;
      if (Object.keys(usage).length > 0) out.usage = usage;
      return out;
    });

    const total: UsageBreakdownTotal = {
      // Already summed exactly via sumAmountStrings — keep every meaningful
      // digit instead of rounding to a fixed decimal count.
      cost: totalCost,
      currency: site.features.currency,
    };
    if (totalTokensIn > 0) total.tokens_in = Math.round(totalTokensIn);
    if (totalTokensOut > 0) total.tokens_out = Math.round(totalTokensOut);
    const totalUsage: Record<string, number> = {};
    if (totalImages > 0) totalUsage.images = Math.round(totalImages);
    if (totalSeconds > 0) totalUsage.seconds = Math.round(totalSeconds);
    if (totalCharacters > 0) totalUsage.characters = Math.round(totalCharacters);
    if (Object.keys(totalUsage).length > 0) total.usage = totalUsage;

    void this.cache;
    return {
      model_id: options.modelFilter ?? 'all',
      period: { from: options.from, to: options.to },
      granularity: options.granularity,
      rows: breakdownRows,
      total,
    };
  }
}
