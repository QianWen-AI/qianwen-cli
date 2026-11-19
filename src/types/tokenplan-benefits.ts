export interface TokenPlanSupportedModel {
  modelId: string;
  modelBrand: string;
  modelName: string;
  capabilities: string[];
  badgeLabel?: string;
  badgeDescription?: string;
  isNew?: boolean;
}

export interface TokenPlanHarnessCatalogItem {
  toolId: string | null;
  toolName: string;
  freeQuota: string | null;
  quotaUnit: string | null;
  discount: string | null;
  discountType: string | null;
}

export interface TokenPlanHarnessAllowance {
  toolId: string | null;
  toolName: string;
  totalQuota: string | null;
  remainingQuota: string | null;
  quotaUnit: string | null;
  startAt: string | null;
  endAt: string | null;
}
