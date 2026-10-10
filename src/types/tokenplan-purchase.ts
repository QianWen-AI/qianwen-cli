import type { TokenPlanBillingCycle } from './tokenplan-catalog.js';
import type { TokenPlanEdition } from './tokenplan-subscription.js';
import type { CashPaymentCapabilities, CashFundingPlan } from './tokenplan-payment.js';
import { TOKEN_PLAN_INDIVIDUAL_TYPES } from './tokenplan-tiers.js';

export { TOKEN_PLAN_INDIVIDUAL_TYPES } from './tokenplan-tiers.js';

export const TOKEN_PLAN_PURCHASE_TYPES = [
  ...TOKEN_PLAN_INDIVIDUAL_TYPES,
  'token_plan_team',
] as const;

export const MAX_TOKEN_PLAN_TEAM_SEATS = 150;

export interface TokenPlanSelection {
  type: string;
  edition: TokenPlanEdition;
  billingCycle: TokenPlanBillingCycle;
  seats: ReadonlyArray<{ specCode: string; quantity: number }>;
  autoRenew: boolean;
  balanceDeduction: string | null;
}

export interface TokenPlanCoupon {
  id: string;
  name: string;
  balance?: string;
  faceValue?: string;
  validUntil?: string;
  deductionAmount?: string;
  recommended?: boolean;
}

export interface TokenPlanQuote {
  amount: string;
  tradeAmount: string;
  currency: 'CNY';
  coupon: string;
  coupons: TokenPlanCoupon[];
  originalAmount: string;
  planAmount: string;
  promotionDeduction: string;
  couponDeduction: string;
}

export interface TokenPlanPaymentDisplayDetails {
  paymentOrderId: string;
  type: string;
  billingCycle: TokenPlanBillingCycle;
  payableAmount: string;
  totalSeats?: number;
}

export interface TokenPlanPurchasePreview {
  selection: TokenPlanSelection;
  quote: TokenPlanQuote;
  balance: string;
  maxDeduction: string;
  balanceDeduction: string;
  externalPayable: string | null;
  deductionValid: boolean;
  changed: boolean;
  capabilities: CashPaymentCapabilities;
  fundingPlan: CashFundingPlan | null;
  deductionIntent: CashFundingPlan['deductionIntent'];
  existingOrder?: {
    paymentOrderId: string;
    orderIds: string[];
    confirmedFundingPlan: CashFundingPlan;
  };
}

export interface TokenPlanPurchaseResult {
  stage: 'preflight' | 'create' | 'payment';
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'unknown' | 'pending';
  type: string;
  billingCycle: TokenPlanBillingCycle;
  amount: string | null;
  currency: 'CNY' | null;
  requestedAutoRenew: boolean;
  autoRenewStatus: 'enabled' | 'disabled' | 'unknown';
  paymentOrderId: string | null;
  orderIds: string[] | null;
  activationStatus: 'not_checked' | 'pending' | 'visible';
  paymentMode?: string;
  cashDeduction?: string;
  externalPayable?: string;
  settledAmount?: string;
  settlementDrifted?: boolean;
  paymentAttempted?: boolean;
  paymentUrl?: string;
  reason?: string;
  warning?: string;
  period?: { start: string; end: string };
  seatSummary?: Array<{ type: string; quantity: number }>;
}
