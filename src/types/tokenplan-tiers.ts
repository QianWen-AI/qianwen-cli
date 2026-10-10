export const TOKEN_PLAN_INDIVIDUAL_TIERS = [
  {
    specCode: 'lite',
    type: 'token_plan_individual_lite',
    name: 'Lite',
    configurationName: 'Lite套餐',
  },
  {
    specCode: 'essential',
    type: 'token_plan_individual_essential',
    name: 'Essential',
    configurationName: 'Essential套餐',
  },
  {
    specCode: 'standard',
    type: 'token_plan_individual_standard',
    name: 'Standard',
    configurationName: 'Standard套餐',
  },
  {
    specCode: 'pro',
    type: 'token_plan_individual_pro',
    name: 'Pro',
    configurationName: 'Pro套餐',
  },
] as const;

export type TokenPlanIndividualTier = (typeof TOKEN_PLAN_INDIVIDUAL_TIERS)[number]['specCode'];
export type TokenPlanIndividualType = (typeof TOKEN_PLAN_INDIVIDUAL_TIERS)[number]['type'];

export const TOKEN_PLAN_INDIVIDUAL_TYPES: readonly TokenPlanIndividualType[] =
  TOKEN_PLAN_INDIVIDUAL_TIERS.map((tier) => tier.type);

export function findTokenPlanIndividualTierBySpecCode(value: unknown) {
  return TOKEN_PLAN_INDIVIDUAL_TIERS.find((tier) => tier.specCode === value);
}

export function findTokenPlanIndividualTierByType(value: unknown) {
  return TOKEN_PLAN_INDIVIDUAL_TIERS.find((tier) => tier.type === value);
}

export function isTokenPlanIndividualTier(value: unknown): value is TokenPlanIndividualTier {
  return findTokenPlanIndividualTierBySpecCode(value) !== undefined;
}
