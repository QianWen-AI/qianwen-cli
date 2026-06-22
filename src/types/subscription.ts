// Service DTO + ViewModel-facing types for the subscription command
// group. Status is composed from up to six concurrent sub-calls; each
// failure is recorded in a diagnostics[] entry so the JSON consumer
// can reason about partial data.

export type SubscriptionPlanKind = 'token' | 'coding';

export interface SubscriptionPeriod {
  start: string;
  end: string;
}

export interface SubscriptionQuota {
  remaining: number;
  total: number;
  usedPct: number;
}

export interface SubscriptionSeatTier {
  specType: string;
  seats: number;
  totalCredits: number;
  remainingCredits: number;
  usedPct: number;
  nextCycleFlushTime: string | null;
}

export interface SubscriptionCreditPack {
  instanceId: string;
  totalCredits: number;
  remainingCredits: number;
  expiresAt: string | null;
}

export interface SubscriptionRecentOrder {
  orderId: string;
  orderType: string;
  orderTime: string;
  amount: string;
  status: string;
}

export interface SubscriptionStatus {
  isGray: boolean | null;
  plan: string | null;
  period: SubscriptionPeriod | null;
  quota: SubscriptionQuota | null;
  autoRenew: boolean | null;
  renewable: boolean | null;
  remainingDays: number | null;
  seatTiers: SubscriptionSeatTier[];
  creditPacks: SubscriptionCreditPack[];
  recentOrders: SubscriptionRecentOrder[];
}

export interface SubscriptionDiagnostic {
  api: string;
  errorCode: string;
  errorMessage: string;
}

export interface SubscriptionStatusResult {
  data: SubscriptionStatus | null;
  diagnostics: SubscriptionDiagnostic[];
}

// ────────────────────────────────────────────────────────────────────
// Adapter DTOs (raw → service-facing)
// ────────────────────────────────────────────────────────────────────

export interface SubscriptionGrayDto {
  isGray: boolean | null;
}

export interface SeatSubscriptionSummaryDto {
  plan: string | null;
  planCode: string | null;
  period: SubscriptionPeriod | null;
  seats: number | null;
}

export interface SubscriptionDetailInstance {
  instanceId: string;
  status: string;
  plan: string | null;
  period: SubscriptionPeriod | null;
}

export interface SubscriptionDetailDto {
  instances: SubscriptionDetailInstance[];
  activeInstance: SubscriptionDetailInstance | null;
}

export interface AutoRenewalDto {
  autoRenew: boolean | null;
}

export interface InstancesRenewableDto {
  renewable: boolean | null;
}

// ────────────────────────────────────────────────────────────────────
// Orders
// ────────────────────────────────────────────────────────────────────

export type OrderType = 'purchase' | 'renew' | 'refund' | 'upgrade' | 'unknown' | string;

export interface OrderDetailLine {
  name: string;
  quantity: number;
  amount: string;
}

export interface OrderDetail {
  orderId: string;
  orderType: string;
  orderTime: string;
  amount: string;
  status: string;
  items: OrderDetailLine[];
  invoiceUrl: string | null;
}

export interface SubscriptionOrder {
  orderId: string;
  orderType: string;
  orderTime: string;
  amount: string;
  currency?: string;
  status: string;
  detail?: OrderDetail | null;
  detailError?: string | null;
}

export interface OrderListPagination {
  totalCount: number;
  pageSize: number;
  currentPage: number;
}

export interface OrderListDto {
  orders: SubscriptionOrder[];
  pagination: OrderListPagination;
}

export interface SubscriptionOrdersPagination {
  page: number;
  pageSize: number;
  total: number;
}

export interface SubscriptionOrders {
  orders: SubscriptionOrder[];
  pagination: SubscriptionOrdersPagination;
}

export type SubscriptionOrdersResult = SubscriptionOrders;

export interface ListOrdersOptions {
  from?: string;
  to?: string;
  type?: OrderType;
  page: number;
  pageSize: number;
  expandDetail?: boolean;
  commodityCodeList?: string;
}
