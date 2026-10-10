import type { SubscriptionDiagnostic } from './subscription.js';

// ────────────────────────────────────────────────────────────────────
// Service DTO types — output of SubscriptionTokenPlanService
// ────────────────────────────────────────────────────────────────────

export interface TokenPlanSeatGroup {
  specType: string;
  seats: number | null;
  assigned: number | null;
  totalValue: string | null;
  surplusValue: string | null;
  unit: string;
  nextCycleFlushTime: string | null;
}

export interface TokenPlanSeatTotal {
  seats: number | null;
  totalValue: string | null;
  surplusValue: string | null;
  unit: string;
}

export interface TokenPlanPeriod {
  start: string;
  end: string;
  remainingDays: number | null;
}

export interface TokenPlanAutoRenew {
  enabled: boolean;
  period: number | null;
  periodUnit: string | null;
}

export interface TokenPlanRenewable {
  canRenew: boolean;
  interceptCode: string | null;
}

export interface TokenPlanSeatSummary {
  groups: TokenPlanSeatGroup[];
  total: TokenPlanSeatTotal | null;
}

export type TokenPlanEdition = 'individual' | 'team';
export type TokenPlanSubscriptionState = 'active' | 'not_subscribed' | 'unknown';
export type TokenPlanCompleteness = 'complete' | 'partial' | 'unknown';

export interface TokenPlanSeatDetail {
  instanceCode: string;
  specType: string | null;
  status: string | null;
  assignment: 'assigned' | 'unassigned' | 'unknown';
  totalValue: string | null;
  surplusValue: string | null;
}

export interface TokenPlanSeatDetails {
  /** Current seats and records whose status is unknown; confirmed historical seats are omitted. */
  items: TokenPlanSeatDetail[];
  /** Includes historical records; independent of the current seat summary. */
  fetchedCount: number;
  totalCount: number | null;
  historicalCount: number;
  /** Pagination and record identity only; missing optional fields do not make collection partial. */
  collectionCompleteness: TokenPlanCompleteness;
  /** Overall completeness of the collection and the displayed current-seat fields. */
  completeness: TokenPlanCompleteness;
  diagnostics: SubscriptionDiagnostic[];
}

export interface TokenPlanSeatDetailsViewModel {
  title: string;
  headers: string[];
  rows: string[][];
  note: string;
  noteAfterRows: boolean;
}

export interface TokenPlanCreditWindow {
  total: number | null;
  used: number | null;
  remaining: number | null;
  /** Server-reported used percentage. Absolute Credits remain unknown when omitted by the API. */
  usedPct?: number | null;
  /** Server-reported reset time normalized to ISO-8601. */
  resetTime?: string | null;
}

export interface TokenPlanEditionStatus {
  edition: TokenPlanEdition;
  commodityCode: string;
  status: TokenPlanSubscriptionState;
  type: string | null;
  name: string | null;
  specCode: string | null;
  period: TokenPlanPeriod | null;
  remainingDays: number | null;
  /** Omitted until a subscription API provides a confirmed billing cycle. */
  billingCycle?: string;
  autoRenew: TokenPlanAutoRenew | null;
  /** Present only while the personal usage API reports an active seven-day window. */
  weeklyCredits?: TokenPlanCreditWindow;
  /** Present only while the personal usage API reports a monthly window (current production cycle). */
  monthlyCredits?: TokenPlanCreditWindow;
  /** Compatibility field used by team subscriptions; personal subscriptions omit it. */
  fiveHourCredits?: TokenPlanCreditWindow;
  seatSummary: TokenPlanSeatSummary | null;
  /** Collected only for status commands, independently of subscription validity. */
  seatDetails?: TokenPlanSeatDetails;
  completeness: TokenPlanCompleteness;
  diagnostics: SubscriptionDiagnostic[];
}

export interface TokenPlanEditionSection {
  edition: TokenPlanEdition;
  title: string;
  fields: Array<{ label: string; value: string }>;
}

export interface TokenPlanStatusResult {
  individual?: TokenPlanEditionStatus;
  team?: TokenPlanEditionStatus;
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
  individual: TokenPlanEditionStatus | undefined;
  team: TokenPlanEditionStatus | undefined;
  editionSections: TokenPlanEditionSection[];

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
  seatDetails?: TokenPlanSeatDetailsViewModel;

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
  specType?: 'standard' | 'pro' | 'max' | string;
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
