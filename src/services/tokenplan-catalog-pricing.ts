import type { ApiClient } from '../api/api-client.js';
import {
  parseTokenPlanCatalogInventory,
  parseTokenPlanCatalogPrice,
  type TokenPlanCatalogPrice,
} from '../api/parsers/tokenplan-catalog-price.js';
import { NO_TOKENPLAN_COUPON, parseTokenPlanCommodity } from '../api/parsers/tokenplan-trade.js';
import type { TokenPlanBillingCycle } from '../types/tokenplan-catalog.js';
import type { TokenPlanEdition } from '../types/tokenplan-subscription.js';
import { findTokenPlanIndividualTierBySpecCode } from '../types/tokenplan-tiers.js';
import { CliError } from '../utils/errors.js';
import { buildTokenPlanConfigurations, tokenPlanCommodityCode } from './tokenplan-configuration.js';

export type { TokenPlanCatalogPrice } from '../api/parsers/tokenplan-catalog-price.js';

export function buildTokenPlanCatalogConfiguration(
  edition: TokenPlanEdition,
  specCode: string,
  billingCycle: TokenPlanBillingCycle,
  commodity: Record<string, unknown>,
): Record<string, unknown> {
  const supportedTier =
    edition === 'individual'
      ? findTokenPlanIndividualTierBySpecCode(specCode) !== undefined
      : ['standard', 'pro', 'max'].some((tier) => tier === specCode);
  if (
    !['individual', 'team'].includes(edition) ||
    !supportedTier ||
    !['monthly', 'quarterly', 'yearly'].includes(billingCycle) ||
    (edition === 'team' && billingCycle === 'quarterly')
  ) {
    throw new CliError({
      code: 'TOKENPLAN_CATALOG_CONFIGURATION_INVALID',
      message: 'Token Plan catalog tier or billing cycle is unsupported.',
      exitCode: 4,
    });
  }
  // QueryOrderLight prices each tier with a lightweight, coupon-free configuration
  // (empty orderParams/config, couponForSpecItem:false, couponNum:'').
  const selection = {
    type: edition === 'individual' ? `token_plan_individual_${specCode}` : 'token_plan_team',
    edition,
    billingCycle,
    autoRenew: false,
    balanceDeduction: null,
    seats: [{ specCode, quantity: 1 }],
  } as const;
  const full = buildTokenPlanConfigurations(commodity, selection, NO_TOKENPLAN_COUPON)[0];
  return { ...full, orderParams: {}, config: {}, couponForSpecItem: false, couponNum: '' };
}

export class TokenPlanCatalogPricing {
  constructor(private readonly apiClient: ApiClient) {}

  async getCommodity(
    edition: TokenPlanEdition,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const commodityCode = tokenPlanCommodityCode(edition);
    const result = await this.apiClient.callOrchestrationApi({
      action: 'GetCommodity',
      path: '/data/publicCustom.json',
      authMode: 'none',
      params: { commodityCode, orderType: 'BUY' },
      signal,
      parse: (data) => parseTokenPlanCommodity(data, commodityCode),
    });
    signal?.throwIfAborted();
    return result;
  }

  async getPrice(
    configuration: Record<string, unknown>,
    options: {
      edition: TokenPlanEdition;
      specCode: string;
      authenticated: boolean;
      signal?: AbortSignal;
    },
  ): Promise<TokenPlanCatalogPrice> {
    const { signal, authenticated } = options;
    signal?.throwIfAborted();
    // The pricing catalog page prices every tier (individual and team) via the public
    // QueryOrderLight; the card amount is read from articleItemResults[].price.discountedTotalPrice.
    const result = await this.apiClient.callOrchestrationApi({
      action: 'QueryOrderLight',
      path: '/data/publicCustom.json',
      authMode: authenticated ? 'optional' : 'none',
      params: configuration,
      signal,
      parse: (data) =>
        parseTokenPlanCatalogPrice(data, configuration, {
          edition: options.edition,
          specCode: options.specCode,
        }),
    });
    signal?.throwIfAborted();
    return result;
  }

  async getInventory(
    configuration: Record<string, unknown>,
    options: { authenticated: boolean; signal?: AbortSignal },
  ): Promise<boolean> {
    options.signal?.throwIfAborted();
    const result = await this.apiClient.callOrchestrationApi({
      action: 'CheckInventory',
      path: '/data/publicCustom.json',
      authMode: options.authenticated ? 'optional' : 'none',
      params: configuration,
      signal: options.signal,
      parse: parseTokenPlanCatalogInventory,
    });
    options.signal?.throwIfAborted();
    return result;
  }
}
