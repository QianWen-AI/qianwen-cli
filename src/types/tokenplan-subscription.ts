import type { SubscriptionDiagnostic } from './subscription.js';

// ────────────────────────────────────────────────────────────────────
// Service DTO types — output of SubscriptionTokenPlanService
// ────────────────────────────────────────────────────────────────────

export interface TokenPlanSeatGroup {
  specType: string;
  seats: number;
  assigned: number;
  totalValue: string;
  surplusValue: string;
  unit: string;
  nextCycleFlushTime: string | null;
}

export interface TokenPlanSeatTotal {
  seats: number;
  totalValue: string;
  surplusValue: string;
  unit: string;
}

export interface TokenPlanPeriod {
  start: string;
  end: string;
  remainingDays: number;
}

export interface TokenPlanAutoRenew {
  enabled: boolean;
  period: number;
  periodUnit: string;
}

export interface TokenPlanRenewable {
  canRenew: boolean;
  interceptCode: string | null;
}

export interface TokenPlanSeatSummary {
  groups: TokenPlanSeatGroup[];
  total: TokenPlanSeatTotal | null;
}

export interface TokenPlanStatusResult {
  product: string;
  period: TokenPlanPeriod | null;
  autoRenew: TokenPlanAutoRenew | null;
  renewable: TokenPlanRenewable | null;
  seatSummary: TokenPlanSeatSummary | null;
  diagnostics: SubscriptionDiagnostic[];
}

// ────────────────────────────────────────────────────────────────────
// ViewModel types — consumed by TUI / TEXT / JSON renderers
// ────────────────────────────────────────────────────────────────────

export interface TokenPlanStatusViewModelHeader {
  product: string;
  period: string;
  autoRenew: string;
  renewable: string;
}

export interface TokenPlanStatusSeatLine {
  specType: string;
  seats: string;
  totalValue: string;
  surplusValue: string;
  nextCycleFlushTime: string;
}

export interface TokenPlanStatusTable {
  rows: TokenPlanStatusSeatLine[];
  totalRow: TokenPlanStatusSeatLine | null;
}

export interface TokenPlanStatusFooter {
  total: TokenPlanStatusSeatLine | null;
  diagnostics: SubscriptionDiagnostic[];
}

export interface TokenPlanStatusViewModel {
  format: 'tui' | 'text' | 'json';

  // JSON-mode fields (top-level, matching the JSON output structure)
  product: string;
  period: TokenPlanPeriod | null;
  autoRenew: TokenPlanAutoRenew | null;
  renewable: TokenPlanRenewable | null;
  seatSummary: TokenPlanSeatSummary | null;

  // TUI/TEXT-mode fields
  header: TokenPlanStatusViewModelHeader | undefined;
  table: TokenPlanStatusTable | null;
  footer: TokenPlanStatusFooter | undefined;
  seatLines: TokenPlanStatusSeatLine[] | undefined;
  totalLine: TokenPlanStatusSeatLine | undefined;

  // Diagnostics
  warnings: string[] | undefined;
  diagnostics: SubscriptionDiagnostic[];
  footnote: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Seats — Service DTO types
// ────────────────────────────────────────────────────────────────────

export interface TokenPlanSeatCycle {
  startTime: string | null;
  endTime: string | null;
  totalValue: string;
  surplusValue: string;
  unit: string;
}

export interface TokenPlanSeatConfig {
  planType: string | null;
  creditValue: number | null;
  seatNum: number | null;
  quotaCycle: string | null;
}

export interface TokenPlanSeatItem {
  instanceCode: string;
  specType: string;
  status: string;
  memberId: string;
  assignable: boolean;
  assignment: string;
  payMode: string;
  productType: string;
  cycle: TokenPlanSeatCycle | null;
  config: TokenPlanSeatConfig | null;
}

export interface TokenPlanSeatsPage {
  current: number;
  size: number;
  total: number;
}

export interface TokenPlanSeatsFilter {
  specType: string | null;
}

export interface TokenPlanSeatsResult {
  page: TokenPlanSeatsPage;
  filter: TokenPlanSeatsFilter;
  items: TokenPlanSeatItem[];
  diagnostics: SubscriptionDiagnostic[];
}

export interface ListTokenPlanSeatsParams {
  page?: number;
  pageSize?: number;
  specType?: 'pro' | 'standard' | string;
}

// ────────────────────────────────────────────────────────────────────
// Seats — ViewModel types
// ────────────────────────────────────────────────────────────────────

export type SeatStatusColor = 'green' | 'gray' | 'orange';

export interface TokenPlanSeatsRow {
  instanceCode: string;
  specType: string;
  status: string;
  statusColor: SeatStatusColor;
  memberIdMasked: string;
  totalValue: string;
  surplusValue: string;
  assignment: string;
}

export interface TokenPlanSeatsHeader {
  total: string;
  filter: string;
}

export interface TokenPlanSeatsFooter {
  pagination: string;
  total: string;
  warnings: string[];
}

export interface TokenPlanSeatsViewModel {
  format: 'tui' | 'text' | 'json';

  // JSON-mode fields
  page: TokenPlanSeatsPage;
  filter: TokenPlanSeatsFilter;
  items: TokenPlanSeatItem[];

  // TUI/TEXT-mode fields
  header: TokenPlanSeatsHeader | undefined;
  rows: TokenPlanSeatsRow[] | undefined;
  footer: TokenPlanSeatsFooter | undefined;
  emptyPlaceholder: string | undefined;

  // Diagnostics
  warnings: string[] | undefined;
  diagnostics: SubscriptionDiagnostic[];
  footnote: string | null;
}
