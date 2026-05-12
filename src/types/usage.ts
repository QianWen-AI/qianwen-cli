// Usage summary response
export interface UsageSummaryResponse {
  period: { from: string; to: string };
  free_tier: FreeTierUsage[];
  token_plan: TokenPlan;
  pay_as_you_go: PayAsYouGo;
}

export interface FreeTierUsage {
  model_id: string;
  quota: {
    remaining: number;
    total: number;
    unit: string;
    used_pct: number;
    status?: 'valid' | 'exhaust' | 'expire';
    resetDate: string | null;
  } | null;
}


export interface TokenPlan {
  subscribed: boolean;
  planName?: string; // e.g. "Token Plan 团队版（月）"
  status?: 'valid' | 'exhaust' | 'invalid';
  totalCredits?: number; // InitCapacityBaseValue
  remainingCredits?: number; // CurrCapacityBaseValue (or periodMonthlyShift)
  usedPct?: number; // computed: (total - remaining) / total * 100
  resetDate?: string; // ISO date derived from EndTime ms timestamp
  addonRemaining?: number; // sum of all addon CurrCapacityBaseValue
}


export interface PayAsYouGo {
  models: PayAsYouGoModel[];
  total: { cost: number; currency: string };
}

export interface PayAsYouGoModel {
  model_id: string;
  usage: Record<string, number>; // tokens_in, tokens_out, images, characters, seconds
  cost: number;
  currency: string;
}

// Usage breakdown response
export interface UsageBreakdownResponse {
  model_id: string;
  billing?: string; // billing source identifier
  period: { from: string; to: string };
  granularity: 'day' | 'month' | 'quarter';
  rows: UsageBreakdownRow[];
  total: UsageBreakdownTotal;
}

export interface UsageBreakdownUsage {
  tokens_in?: number;
  tokens_out?: number;
  images?: number;
  characters?: number;
  seconds?: number;
}

export interface UsageBreakdownRow {
  period: string;
  tokens_in?: number;
  tokens_out?: number;
  usage?: UsageBreakdownUsage;
  cost?: number;
  currency?: string;
}

export interface UsageBreakdownTotal {
  tokens_in?: number;
  tokens_out?: number;
  usage?: UsageBreakdownUsage;
  cost?: number;
  currency?: string;
}
