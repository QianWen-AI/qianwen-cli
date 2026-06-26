/** Token Plan status orchestration. */

import type { ApiClient } from '../api/api-client.js';
import type { CachedFetcher } from '../types/cache.js';
import type { FrInstanceItem, FrInstanceResponse } from '../types/api-models.js';
import type { TokenPlan } from '../types/usage.js';
import { addDiagnostic } from '../api/debug-buffer.js';
import { site } from '../site.js';

const API_PRODUCT_BSS = 'BssOpenAPI-V3';
const API_ACTION_DESCRIBE_FR = 'DescribeFrInstances';

export class TokenplanService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly cache: CachedFetcher,
  ) {}

  /** Fetch the user's Token Plan view. Failures degrade to subscribed=false. */
  async fetchTokenPlan(): Promise<TokenPlan> {
    try {
      const codes = site.features.tokenPlanCommodityCodes;
      const [teamsRes, personalRes, addonRes] = await Promise.all([
        this.fetchFrInstances(codes.teams, 10),
        this.fetchFrInstances(codes.personal, 10),
        this.fetchFrInstances(codes.addon, 100),
      ]);

      const allPlanInstances = [...(teamsRes?.Data ?? []), ...(personalRes?.Data ?? [])];
      const validInstance =
        allPlanInstances.find((inst) => {
          const statusCode = typeof inst.Status === 'object' ? inst.Status?.Code : inst.Status;
          return statusCode === 'valid';
        }) ?? allPlanInstances[0];

      const addonRemaining = (addonRes?.Data ?? [])
        .filter((inst) => {
          const statusCode = typeof inst.Status === 'object' ? inst.Status?.Code : inst.Status;
          return statusCode === 'valid';
        })
        .reduce(
          (sum: number, inst: FrInstanceItem) => sum + Number(inst.CurrCapacityBaseValue || 0),
          0,
        );

      if (!validInstance) {
        if (addonRemaining > 0) return { subscribed: false, addonRemaining };
        return { subscribed: false };
      }

      return this.buildTokenPlanDto(validInstance, addonRemaining);
    } catch (error) {
      addDiagnostic(
        'TokenPlan',
        `fetch failed, treating as not subscribed: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return { subscribed: false };
    } finally {
      void this.cache;
    }
  }

  private async fetchFrInstances(
    commodityCode: string,
    pageSize: number,
  ): Promise<FrInstanceResponse | null> {
    try {
      const result = await this.apiClient.callFlatApi<FrInstanceResponse>({
        product: API_PRODUCT_BSS,
        action: API_ACTION_DESCRIBE_FR,
        params: {
          Group: 'tokenPlan',
          CommodityCode: commodityCode,
          PageNum: 1,
          PageSize: pageSize,
        },
      });
      return result ?? null;
    } catch (error) {
      addDiagnostic(
        'TokenPlan',
        `DescribeFrInstances failed for ${commodityCode}: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return null;
    }
  }

  private buildTokenPlanDto(instance: FrInstanceItem, addonRemaining: number): TokenPlan {
    const statusCode =
      typeof instance.Status === 'object' ? instance.Status?.Code : instance.Status;
    const totalCredits = Number(instance.InitCapacityBaseValue || 0);
    const capacityType = instance.CapacityTypeCode ?? '';
    const remainingCredits =
      capacityType === 'periodMonthlyShift'
        ? Number(instance.periodCapacityBaseValue || instance.CurrCapacityBaseValue || 0)
        : Number(instance.CurrCapacityBaseValue || 0);
    const usedPct = totalCredits > 0 ? ((totalCredits - remainingCredits) / totalCredits) * 100 : 0;
    const resetDate = instance.EndTime ? new Date(instance.EndTime).toISOString() : undefined;

    const dto: TokenPlan = {
      subscribed: statusCode === 'valid',
      planName: instance.TemplateName ?? instance.CommodityName,
      status: statusCode as TokenPlan['status'],
      totalCredits,
      remainingCredits,
      usedPct,
    };
    if (resetDate) dto.resetDate = resetDate;
    if (addonRemaining > 0) dto.addonRemaining = addonRemaining;
    return dto;
  }
}
