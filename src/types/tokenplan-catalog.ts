import type { SubscriptionDiagnostic } from './subscription.js';
import type { TokenPlanEdition } from './tokenplan-subscription.js';
import type { TokenPlanSupportedModel } from './tokenplan-benefits.js';

export type TokenPlanBillingCycle = 'monthly' | 'quarterly' | 'yearly';
export type TokenPlanListEdition = 'all' | TokenPlanEdition;

export interface TokenPlanCatalogMetadata {
  billingCycles: TokenPlanBillingCycle[] | null;
  tiers: Array<{ specCode: string; name: string | null; monthlyCredits: string | null }>;
}

export interface TokenPlanListRow {
  type: string;
  specCode: string;
  seatType: string | null;
  name: string | null;
  price: string | null;
  currency: 'CNY' | null;
  inventory: boolean | null;
  /** Omitted when the personal quota API does not report a seven-day limit. */
  weeklyCredits?: number;
  /**
   * Team: commodity-configured decimal string. Individual: quota-config `monthly`
   * normalized via String() only when the API reports no weekly limit
   * (weekly-first fallback, mirroring the pricing page card).
   */
  monthlyCredits: string | number | null;
  status: 'purchasable' | 'upgrade' | 'unavailable' | 'subscribed' | 'unknown';
}

export interface TokenPlanListSection {
  edition: TokenPlanEdition;
  billingCycleSupported: boolean | null;
  subscriptionStatus: 'active' | 'not_subscribed' | 'unknown';
  currentPlan: string | null;
  currentBillingCycle: string | null;
  subscriptionUrl: string | null;
  rows: TokenPlanListRow[];
  diagnostics: SubscriptionDiagnostic[];
  currentPlanDetails?: TokenPlanCurrentPlanDetails | null;
  plans?: TokenPlanCatalogPlan[];
}

export interface TokenPlanCurrentPlanDetails {
  subscriptionId: string | null;
  endAt: string | null;
  totalCredits: string | null;
  remainingCredits: string | null;
  /** Personal quota is reported as a ratio, not an absolute credit balance. */
  usedPct?: number | null;
  remainingPct?: number | null;
  quotaWindowType?: 'weekly' | 'monthly' | null;
}

export interface TokenPlanCatalogPlan {
  tier?: string;
  seatType?: string;
  billingTerm: TokenPlanBillingCycle;
  listPrice: string | null;
  promoPrice: string | null;
  currency: 'CNY' | null;
  quotaWindows: Array<{ windowType: 'weekly' | 'monthly'; totalCredits: string }>;
  /** Null indicates a failed or unavailable expansion; an empty array is confirmed empty. */
  supportedModels?: TokenPlanSupportedModel[] | null;
}

export interface TokenPlanListResult {
  authenticated: boolean;
  edition: TokenPlanListEdition;
  billingCycle: TokenPlanBillingCycle;
  completeness: 'complete' | 'partial' | 'unknown';
  sections: TokenPlanListSection[];
}

export interface TokenPlanListOptions {
  authenticated?: boolean;
  edition?: TokenPlanListEdition;
  billingCycle?: TokenPlanBillingCycle;
  includeModels?: boolean;
  signal?: AbortSignal;
}
