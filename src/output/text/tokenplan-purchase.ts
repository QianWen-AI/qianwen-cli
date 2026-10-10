import type { TokenPlanPurchaseResultViewModel } from '../../view-models/subscription/tokenplan-purchase.js';

export function renderTextTokenPlanPurchase(vm: TokenPlanPurchaseResultViewModel): void {
  process.stdout.write(`${vm.title}\n\n${vm.lines.join('\n')}\n`);
}
