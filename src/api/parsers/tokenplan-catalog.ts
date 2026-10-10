import { GatewayShapeError } from '../request-adapter.js';
import type { TokenPlanEdition } from '../../types/tokenplan-subscription.js';
import type {
  TokenPlanBillingCycle,
  TokenPlanCatalogMetadata,
} from '../../types/tokenplan-catalog.js';
import {
  TOKEN_PLAN_INDIVIDUAL_TIERS,
  type TokenPlanIndividualTier,
} from '../../types/tokenplan-tiers.js';

export type TokenPlanCatalogQuota = Partial<
  Record<TokenPlanIndividualTier, { weekly: number | null; monthly: number | null }>
>;

function object(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function label(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function uniqueChoice(choices: unknown, value: string): Record<string, unknown> | null {
  if (!Array.isArray(choices)) return null;
  const matches = choices.filter((choice) => object(choice)?.value === value);
  return matches.length === 1 ? object(matches[0]) : null;
}

function billingCycles(
  choices: unknown,
  edition: TokenPlanEdition,
): TokenPlanBillingCycle[] | null {
  if (!Array.isArray(choices)) return null;
  const mapping: Record<string, TokenPlanBillingCycle> = {
    '1:Month': 'monthly',
    '3:Month': 'quarterly',
    '1:Year': 'yearly',
  };
  const result = new Set<TokenPlanBillingCycle>();
  for (const choice of choices) {
    const value = object(choice)?.value;
    if (typeof value !== 'string' || !value) return null;
    const cycle = Object.hasOwn(mapping, value) ? mapping[value] : undefined;
    if (!cycle) continue;
    if (result.has(cycle)) return null;
    result.add(cycle);
  }
  return [...result].filter((cycle) => edition === 'individual' || cycle !== 'quarterly');
}

export function parseTokenPlanCatalogMetadata(
  data: unknown,
  edition: TokenPlanEdition,
  commodityCode: string,
): TokenPlanCatalogMetadata {
  const raw = object(data);
  const view = object(raw?.viewModel);
  if (
    raw?.successResponse !== true ||
    view?.id !== commodityCode ||
    (view?.commodityCode !== undefined && view.commodityCode !== commodityCode)
  ) {
    throw new GatewayShapeError('Token Plan commodity response is invalid');
  }
  const components = object(raw.components);
  const planComponent = edition === 'individual' ? 'subscription_type' : 'plan_type';
  const choices = object(components?.[planComponent])?.[planComponent];
  const creditChoices = object(components?.credit_value)?.credit_value;
  const creditConstraint = object(object(object(raw.constraint)?.credit_value)?.plan_type);
  const quotaChoices = object(components?.subscription_spec)?.quota_cycle;
  const monthlyQuota =
    Array.isArray(quotaChoices) &&
    quotaChoices.length === 1 &&
    uniqueChoice(quotaChoices, 'byDynamicMonth') !== null;
  const specs =
    edition === 'individual'
      ? TOKEN_PLAN_INDIVIDUAL_TIERS.map((tier) => tier.specCode)
      : ['standard', 'pro', 'max'];
  return {
    billingCycles: billingCycles(object(components?.ord_time)?.ord_time, edition),
    tiers: specs.flatMap((specCode) => {
      const choice = uniqueChoice(choices, specCode);
      if (choice === null) return [];
      let monthlyCredits: string | null = null;
      const constraint = creditConstraint?.[specCode];
      if (
        edition === 'team' &&
        monthlyQuota &&
        Array.isArray(constraint) &&
        constraint.length === 1
      ) {
        const value: unknown = constraint[0];
        if (
          typeof value === 'string' &&
          /^(0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value) &&
          label(uniqueChoice(creditChoices, value)?.text) !== null
        ) {
          monthlyCredits = value;
        }
      }
      return [{ specCode, name: label(choice.text), monthlyCredits }];
    }),
  };
}

function credits(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseTokenPlanCatalogQuota(business: unknown): TokenPlanCatalogQuota {
  const data = object(object(business)?.data);
  if (!data) throw new GatewayShapeError('Personal Token Plan quota configuration is invalid');
  const tier = (specCode: TokenPlanIndividualTier) => {
    const quota = object(data[specCode]);
    return { weekly: credits(quota?.weekly), monthly: credits(quota?.monthly) };
  };
  const result: TokenPlanCatalogQuota = {};
  // Tier whitelist iteration keeps non-tier keys such as addon_quota out of the result.
  for (const { specCode } of TOKEN_PLAN_INDIVIDUAL_TIERS) {
    result[specCode] = tier(specCode);
  }
  return result;
}
