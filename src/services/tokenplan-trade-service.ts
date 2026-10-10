import type { ApiClient } from '../api/api-client.js';
import {
  parseTokenPlanCommodity,
  parseTokenPlanInventory,
  parseTokenPlanQuote,
} from '../api/parsers/tokenplan-trade.js';
import type { TokenPlanSelection, TokenPlanQuote } from '../types/tokenplan-purchase.js';
import { CliError } from '../utils/errors.js';
import { tokenPlanCommodityCode } from './tokenplan-configuration.js';

export class TokenPlanTradeService {
  constructor(private readonly apiClient: ApiClient) {}

  getCommodity(
    edition: TokenPlanSelection['edition'],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const commodityCode = tokenPlanCommodityCode(edition);
    return this.apiClient.callOrchestrationApi({
      action: 'GetCommodity',
      path: '/data/custom.json',
      authMode: 'required',
      params: { commodityCode, orderType: 'BUY' },
      signal,
      parse: (data) => parseTokenPlanCommodity(data, commodityCode),
    });
  }

  async getQuote(
    configurations: ReadonlyArray<Record<string, unknown>>,
    coupon: string,
    signal?: AbortSignal,
  ): Promise<TokenPlanQuote> {
    signal?.throwIfAborted();
    const quote = await this.apiClient.callOrchestrationApi({
      action: 'DescribeMultiPrice',
      path: '/data/custom.json',
      authMode: 'required',
      params: { configurations },
      signal,
      parse: (data) => parseTokenPlanQuote(data, coupon),
    });
    signal?.throwIfAborted();
    return quote;
  }

  getInventory(configuration: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
    return this.apiClient.callOrchestrationApi({
      action: 'CheckInventory',
      path: '/data/publicCustom.json',
      authMode: 'required',
      params: configuration,
      signal,
      parse: parseTokenPlanInventory,
    });
  }

  async checkInventory(
    configurations: ReadonlyArray<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (configurations.length === 0)
      throw new CliError({
        code: 'TOKENPLAN_CONFIGURATION_REQUIRED',
        message: 'No Token Plan configuration was selected.',
        exitCode: 4,
      });
    for (const configuration of configurations) {
      signal?.throwIfAborted();
      if (!(await this.getInventory(configuration, signal))) {
        throw new CliError({
          code: 'TOKENPLAN_OUT_OF_STOCK',
          message: 'A selected Token Plan tier has no inventory.',
          exitCode: 1,
        });
      }
    }
  }
}
