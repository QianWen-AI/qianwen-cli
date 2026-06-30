import type {
  ConsumeSummaryLineItem,
  ConsumeSummaryResponse,
  FqInstanceItem,
  FqInstanceResponse,
  FrInstanceItem,
  FrInstanceResponse,
} from '../../types/api-models.js';
import type {
  UsageLimit,
  ConsumeBreakdownDto,
  ConsumeBreakdownRow,
  SettleBillSummaryDto,
  SettleBillCycle,
} from '../../types/billing-extra.js';
import type { GetFundAccountAvailableAmountResponse, BalanceSummaryDto } from '../../types/balance.js';
import { site } from '../../site.js';

export interface ConsumeLineItemDTO {
  lineItemCat: string;
  billingDate: string;
  billingMonth: string;
  modelId: string;
  usageValue: number;
  cost: number;
  billingUnit: string;
  isFree: boolean;
}

export interface FreeTierQuotaDTO {
  total: number;
  remaining: number;
  usedPct: number;
  templateCode: string;
  templateName: string;
  status: string;
  cycleStart: string;
  cycleEnd: string;
}

export interface TokenPlanDTO {
  subscribed: boolean;
  totalCredits: number;
  remainingCredits: number;
  usedPct: number;
  planName: string;
  status: string;
  endTime?: number;
  enableRenew?: boolean;
  addonRemaining?: number;
}

const SKIP_LINE_ITEM_CATEGORIES = new Set<string>(['Subscription Activation Free']);

function toInt(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    if (value.trim().length === 0) return 0;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function computeUsedPct(total: number, remaining: number): number {
  if (total <= 0) return 0;
  const used = total - remaining;
  const pct = Math.round((used / total) * 100);
  if (Number.isNaN(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

function extractStatus(raw: FrInstanceItem['Status']): string {
  if (typeof raw === 'string') return raw.toLowerCase();
  if (raw && typeof raw === 'object') {
    return (raw.Code ?? '').toLowerCase();
  }
  return '';
}

function toAmountString(value: unknown, fallback = '0'): string {
  if (value == null) return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallback;
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? fallback : trimmed;
  }
  return fallback;
}

function toAmountStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return null;
}

function resolveCurrency(raw: unknown): string {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return site.features.currency;
}

function parseBillingItem(item: ConsumeSummaryLineItem): ConsumeLineItemDTO | null {
  const lineItemCat = item.LineItemCategory ?? '';
  if (SKIP_LINE_ITEM_CATEGORIES.has(lineItemCat)) return null;

  const isFree = lineItemCat.includes('Free');
  const billQuantity = toNumber(item.BillQuantity);
  const stepUnit = item.StepQuantityUnit ?? '';
  const billingItemCode = item.BillingItemCode ?? '';
  const billingUnit = inferBillingUnit(stepUnit, billingItemCode);
  const usageValue = stepUnit ? computeUsageValue(billQuantity, stepUnit) : billQuantity;
  const cost = toNumber(item.RequireAmount ?? item.Amount ?? item.Cost ?? item.ListPrice);
  const billingDate = item.BillingDate ?? '';
  const billingMonth = item.BillingMonth ?? (billingDate ? billingDate.slice(0, 7) : '');
  const modelId = item.ModelName ?? item.Model ?? 'unknown';

  return {
    lineItemCat,
    billingDate,
    billingMonth,
    modelId,
    usageValue,
    cost,
    billingUnit,
    isFree,
  };
}

function inferBillingUnit(stepUnit: string, billingItemCode: string): string {
  const unit = stepUnit.toLowerCase();
  if (unit.includes('token')) return '1K tokens';
  if (unit.includes('second')) return 'seconds';
  if (unit.includes('page')) return 'pages';
  if (unit.includes('image')) return 'images';
  if (unit.includes('char')) return 'chars';
  if (billingItemCode === 'token_number') return '1K tokens';
  if (billingItemCode === 'image_number') return 'images';
  if (billingItemCode === 'video_duration') return 'seconds';
  return stepUnit || billingItemCode || '';
}

function computeUsageValue(billQuantity: number, stepUnit: string): number {
  const lower = stepUnit.toLowerCase();
  if (lower.includes('1k') || lower.includes('1,000')) return billQuantity * 1000;
  if (lower.includes('1m') || lower.includes('1,000,000')) return billQuantity * 1_000_000;
  return billQuantity;
}

export function transformConsumeSummary(raw: ConsumeSummaryResponse): ConsumeLineItemDTO[] {
  const items = raw.Data ?? [];
  const out: ConsumeLineItemDTO[] = [];
  for (const item of items) {
    const parsed = parseBillingItem(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function transformFqItem(item: FqInstanceItem): FreeTierQuotaDTO {
  const total = item.InitCapacity?.BaseValue ?? 0;
  const remaining = item.CurrCapacity?.BaseValue ?? 0;
  return {
    total,
    remaining,
    usedPct: computeUsedPct(total, remaining),
    templateCode: item.Template?.Code ?? '',
    templateName: item.Template?.Name ?? '',
    status: (item.Status ?? '').toLowerCase(),
    cycleStart: item.CurrentCycleStartTime ?? '',
    cycleEnd: item.CurrentCycleEndTime ?? '',
  };
}

export function transformFqInstances(raw: FqInstanceResponse): FreeTierQuotaDTO[] {
  return (raw.Data ?? []).map(transformFqItem);
}

export function transformFrInstances(raw: FrInstanceResponse): TokenPlanDTO {
  const items = raw.Data ?? [];
  if (items.length === 0) {
    return {
      subscribed: false,
      totalCredits: 0,
      remainingCredits: 0,
      usedPct: 0,
      planName: '',
      status: '',
    };
  }
  const primary = items[0]!;
  const total = toInt(primary.InitCapacityBaseValue);
  const remaining = toInt(primary.CurrCapacityBaseValue);
  const planName = primary.CommodityName ?? primary.TemplateName ?? '';
  const status = extractStatus(primary.Status);

  const dto: TokenPlanDTO = {
    subscribed: true,
    totalCredits: total,
    remainingCredits: remaining,
    usedPct: computeUsedPct(total, remaining),
    planName,
    status,
  };

  if (typeof primary.EndTime === 'number') dto.endTime = primary.EndTime;
  if (typeof primary.EnableRenew === 'boolean') dto.enableRenew = primary.EnableRenew;
  if (items.length > 1) {
    const addon = items[1]!;
    dto.addonRemaining = toInt(addon.CurrCapacityBaseValue);
  }
  return dto;
}

interface RawUsageLimit {
  Status?: string;
  LimitAmount?: unknown;
  Currency?: unknown;
  AlertThreshold?: unknown;
  Receivers?: unknown;
  ReceiversMap?: unknown;
}

export function transformUsageLimit(raw: unknown): UsageLimit {
  const safe: RawUsageLimit = (raw ?? {}) as RawUsageLimit;

  const alertThreshold =
    safe.AlertThreshold == null || safe.AlertThreshold === '' ? '0' : String(safe.AlertThreshold);
  return {
    status: safe.Status ?? 'unknown',
    limitAmount: toAmountStringOrNull(safe.LimitAmount),
    currency: resolveCurrency(safe.Currency),
    alertThreshold,
  };
}

interface RawCostAnalysisGroupItem {
  Key?: string;
  Name?: string;
  Amount?: unknown;
  Percentage?: unknown;
}

interface RawCostAnalysisResultByTime {
  Period?: string;
  Total?: { Amount?: unknown; Currency?: unknown };
  PeriodDetails?: RawCostAnalysisGroupItem[];
}

interface RawCostAnalysis {
  GroupByTotal?: RawCostAnalysisGroupItem[];
  ResultByTime?: RawCostAnalysisResultByTime[];
  Items?: Array<{ Period?: string; Amount?: unknown }>;
  CostTotals?: { Currency?: unknown };
  Currency?: unknown;
  Granularity?: string;
}

export function transformConsumeBreakdown(raw: unknown): ConsumeBreakdownDto {
  const safe: RawCostAnalysis = (raw ?? {}) as RawCostAnalysis;
  const groupByTotal = Array.isArray(safe.GroupByTotal) ? safe.GroupByTotal : [];
  const rows: ConsumeBreakdownRow[] = groupByTotal.map((item) => {
    const groupKey = item.Key ?? '';
    const groupLabel = item.Name ?? groupKey;
    return {
      groupKey,
      groupLabel,
      amount: toAmountString(item.Amount, '0'),
    };
  });
  return { rows };
}

interface RawSettleBillCycle {
  BillingCycle?: string;
  TotalPriceSettleFee?: unknown;
  PretaxAmount?: unknown;
  TotalPriceTaxFee?: unknown;
  Tax?: unknown;
  TotalPricePostTaxFee?: unknown;
  AftertaxAmount?: unknown;
  Discount?: unknown;
  PaidAmount?: unknown;
  OutstandingAmount?: unknown;
  Currency?: unknown;
}

interface RawSettleBillSummary {
  Data?: RawSettleBillCycle[];
  Currency?: unknown;
}

export function transformSettleBillSummary(raw: unknown): SettleBillSummaryDto {
  const safe: RawSettleBillSummary = (raw ?? {}) as RawSettleBillSummary;
  const data = Array.isArray(safe.Data) ? safe.Data : [];
  const cycles: SettleBillCycle[] = data.map((c) => ({
    billingCycle: c.BillingCycle ?? '',
    pretaxAmount: toAmountString(c.TotalPriceSettleFee ?? c.PretaxAmount, '0'),
    tax: toAmountString(c.TotalPriceTaxFee ?? c.Tax, '0'),
    aftertaxAmount: toAmountString(c.TotalPricePostTaxFee ?? c.AftertaxAmount, '0'),
  }));
  const firstItemCurrency = data.length > 0 ? data[0]?.Currency : undefined;
  return {
    cycles,
    currency: resolveCurrency(safe.Currency ?? firstItemCurrency),
  };
}

// ────────────────────────────────────────────────────────────────────
// Balance
// ────────────────────────────────────────────────────────────────────

export function transformBalanceSummary(
  raw: GetFundAccountAvailableAmountResponse | null | undefined,
): BalanceSummaryDto {
  const safe = raw ?? ({} as Partial<GetFundAccountAvailableAmountResponse>);
  return {
    availableAmount: safe.AvailableAmount ?? '0',
    currency: safe.Currency ?? 'CNY',
  };
}
