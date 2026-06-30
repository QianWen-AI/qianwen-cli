import type { BalanceSummaryDto } from '../../types/balance.js';
import { formatMoney, type ViewContext } from './shared.js';

export interface BalanceSummaryViewModel {
  availableAmount: string;
  displayAmount: string;
  currency: string;
}

export function buildBalanceSummaryViewModel(
  data: BalanceSummaryDto,
  ctx: ViewContext,
): BalanceSummaryViewModel {
  return {
    availableAmount: data.availableAmount,
    displayAmount: formatMoney(data.availableAmount, ctx),
    currency: data.currency,
  };
}
