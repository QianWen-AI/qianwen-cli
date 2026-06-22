// Service DTO + ViewModel-facing types for billing limit / breakdown /
// analysis / summary commands. Monetary amounts stay as decimal strings
// so they pass through the high-precision sumAmountStrings path without
// IEEE-754 truncation.

// ────────────────────────────────────────────────────────────────────
// DescribeUsageLimit
// ────────────────────────────────────────────────────────────────────

export type UsageLimitStatus = 'normal' | 'active' | 'exceeded' | 'warning' | 'unknown' | string;

export interface UsageLimit {
  status: UsageLimitStatus;
  limitAmount: string | null;
  currency: string;
  alertThreshold: string;
}

// ────────────────────────────────────────────────────────────────────
// MaasListConsumeSummary (grouped) — breakdown rows
// ────────────────────────────────────────────────────────────────────

export type BreakdownGroupBy = 'model' | 'api-key';
export type ChargeType = 'all' | 'postpaid' | 'prepaid';

export interface ConsumeBreakdownRow {
  groupKey: string;
  groupLabel: string;
  amount: string;
}

export interface ConsumeBreakdownDto {
  rows: ConsumeBreakdownRow[];
}

export interface ConsumeBreakdown {
  groupBy: BreakdownGroupBy;
  period: { from: string; to: string };
  chargeType: ChargeType;
  rows: ConsumeBreakdownRow[];
  totalRows: number;
  totalAmount: string;
  currency: string;
}

export interface ConsumeBreakdownOptions {
  groupBy: BreakdownGroupBy;
  from: string;
  to: string;
  chargeType: ChargeType;
  top: number;
  granularity: AnalysisGranularity;
}

// ────────────────────────────────────────────────────────────────────
// Multi-period breakdown (per-period sliced view)
// ────────────────────────────────────────────────────────────────────

export interface ConsumeBreakdownPeriodSlice {
  period: string;
  rows: ConsumeBreakdownRow[];
  totalAmount: string;
}

export interface ConsumeBreakdownByPeriods {
  groupBy: BreakdownGroupBy;
  dateRange: { from: string; to: string };
  granularity: AnalysisGranularity;
  chargeType: ChargeType;
  slices: ConsumeBreakdownPeriodSlice[];
  currency: string;
}

// ────────────────────────────────────────────────────────────────────
// MaasDescribeCostAnalysis
// ────────────────────────────────────────────────────────────────────

export type AnalysisGranularity = 'day' | 'month';

export interface CostAnalysisItem {
  period: string;
  amount: string;
  /** Present when the analysis is grouped (--group-by): the dimension value. */
  groupKey?: string;
  groupLabel?: string;
}

export interface CostAnalysisDto {
  items: CostAnalysisItem[];
  granularity: AnalysisGranularity | string;
  currency: string;
}

export interface CostAnalysis {
  granularity: AnalysisGranularity | string;
  period: { from: string; to: string };
  groupBy?: BreakdownGroupBy;
  chargeTypes?: string[];
  totalAmount: string;
  currency: string;
  items: CostAnalysisItem[];
}

export interface CostAnalysisOptions {
  granularity: AnalysisGranularity;
  from: string;
  to: string;
  groupBy?: BreakdownGroupBy;
  chargeTypes?: string[];
  chargeType?: string[];
  top: number;
}

// ────────────────────────────────────────────────────────────────────
// ListSettleBillTotalSummary
// ────────────────────────────────────────────────────────────────────

export interface SettleBillCycle {
  billingCycle: string;
  pretaxAmount: string;
  tax: string;
  aftertaxAmount: string;
}

export interface SettleBillTotals {
  pretaxAmount: string;
  tax: string;
  aftertaxAmount: string;
}

export interface SettleBillSummaryDto {
  cycles: SettleBillCycle[];
  currency: string;
}

export interface SettleBillSummary {
  cycles: SettleBillCycle[];
  totals: SettleBillTotals;
  currency: string;
  period: { from: string; to: string };
  chargeType?: ChargeType;
}

export interface SettleBillSummaryOptions {
  from: string;
  to: string;
  chargeType: ChargeType;
}
