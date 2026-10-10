import type { SubscriptionDiagnostic } from './subscription.js';
import type { TokenPlanEdition } from './tokenplan-subscription.js';

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
  signal?: AbortSignal;
}
