import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../../output/format.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { withSpinner } from '../../../ui/spinner.js';
import { createServices } from '../../../services/index.js';
import { buildTokenPlanStatusViewModel } from '../../../view-models/subscription/tokenplan-status.js';
import { renderSubscriptionTokenPlanStatusInk } from '../../../ui/SubscriptionTokenPlanStatus.js';
import { handleError, HandledError } from '../../../utils/errors.js';
import type {
  TokenPlanStatusViewModel,
  TokenPlanStatusResult,
} from '../../../types/tokenplan-subscription.js';

function isTotalFailure(result: TokenPlanStatusResult): boolean {
  return (
    result.seatSummary === null &&
    result.period === null &&
    result.autoRenew === null &&
    result.renewable === null
  );
}

export function subscriptionTokenPlanStatusAction(cmd: Command) {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      ensureAuthenticated();
      const { subscriptionTokenPlanService } = createServices();
      const result = await withSpinner(
        'Loading Token Plan status',
        () => subscriptionTokenPlanService.getTokenPlanStatus(),
        format,
      );

      if (format === 'json') {
        const vm = buildTokenPlanStatusViewModel(result, 'json');
        const jsonOutput = {
          product: vm.product,
          period: vm.period,
          autoRenew: vm.autoRenew,
          renewable: vm.renewable,
          seatSummary: vm.seatSummary,
          diagnostics: vm.diagnostics,
        };
        outputJSON(jsonOutput);
        if (isTotalFailure(result)) {
          process.exitCode = 1;
          throw new HandledError(1);
        }
        return;
      }

      const outputFormat = format === 'text' ? 'text' : 'tui';
      const vm: TokenPlanStatusViewModel = buildTokenPlanStatusViewModel(result, outputFormat);

      if (format === 'text') {
        renderTextTokenPlanStatus(vm);
      } else {
        await renderSubscriptionTokenPlanStatusInk(vm);
      }
      if (isTotalFailure(result)) {
        process.exitCode = 1;
        throw new HandledError(1);
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(error, format);
    }
  };
}

function renderTextTokenPlanStatus(vm: TokenPlanStatusViewModel): void {
  console.log('Token Plan Subscription');
  if (vm.header) {
    console.log(`  ${'Product:'.padEnd(14)}${vm.header.product}`);
    console.log(`  ${'Period:'.padEnd(14)}${vm.header.period}`);
    console.log(`  ${'Auto-Renew:'.padEnd(14)}${vm.header.autoRenew}`);
    console.log(`  ${'Renewable:'.padEnd(14)}${vm.header.renewable}`);
  }

  if (vm.seatLines && vm.seatLines.length > 0) {
    console.log('');
    console.log('Seat Summary');
    for (const row of vm.seatLines) {
      console.log(
        `  ${row.specType.padEnd(12)}${row.seats} seats   ${row.totalValue} Credits   ${row.surplusValue} surplus   next ${row.nextCycleFlushTime}`,
      );
    }
    if (vm.totalLine) {
      console.log(
        `  ${vm.totalLine.specType.padEnd(12)}${vm.totalLine.seats} seats   ${vm.totalLine.totalValue} Credits   ${vm.totalLine.surplusValue} surplus`,
      );
    }
  }

  if (vm.warnings && vm.warnings.length > 0) {
    console.log('');
    for (const w of vm.warnings) {
      console.log(`  ${w}`);
    }
  }

  if (vm.footnote) {
    console.log('');
    console.log(`  ${vm.footnote}`);
  }
}
