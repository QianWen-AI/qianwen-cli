import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../../output/format.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { withSpinner } from '../../../ui/spinner.js';
import { buildBalanceSummaryViewModel, defaultViewContext } from '../../../view-models/billing/index.js';
import { renderBalanceSummaryInk } from '../../../ui/BillingBalanceSummary.js';
import { renderTextBalanceSummary } from '../../../output/text/billing.js';
import { handleError } from '../../../utils/errors.js';
import { createServices } from '../../../services/index.js';

export function registerBillingBalanceSummaryCommand(parent: Command): void {
  const summary = parent
    .command('summary')
    .description('Show available account balance')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  summary.action(balanceSummaryAction(summary));
}

export function balanceSummaryAction(cmd: Command) {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      ensureAuthenticated();
      const services = createServices();
      const data = await withSpinner(
        'Fetching balance',
        () => services.billingService.getAvailableBalance(),
        format,
      );

      if (format === 'json') {
        outputJSON({ availableAmount: data.availableAmount, currency: data.currency });
        return;
      }

      const vm = buildBalanceSummaryViewModel(data, defaultViewContext());
      if (format === 'text') {
        renderTextBalanceSummary(vm);
      } else {
        await renderBalanceSummaryInk(vm);
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}
