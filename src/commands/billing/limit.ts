import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { buildBillingLimitViewModel, defaultViewContext } from '../../view-models/billing/index.js';
import { renderBillingLimitInk } from '../../ui/BillingLimit.js';
import { renderTextBillingLimit } from '../../output/text/billing.js';
import { handleError } from '../../utils/errors.js';
import { createServices } from '../../services/index.js';

export function registerBillingLimitCommand(parent: Command): void {
  const limit = parent
    .command('limit')
    .description('Show consumption limit and alert configuration')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  limit.action(billingLimitAction(limit));
}

export function billingLimitAction(cmd: Command) {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      ensureAuthenticated();
      const services = createServices();
      const data = await withSpinner(
        'Fetching usage limit',
        () => services.billingService.getUsageLimit(),
        format,
      );

      if (format === 'json') {
        outputJSON(data);
        return;
      }

      const vm = buildBillingLimitViewModel(data, defaultViewContext());
      if (format === 'text') {
        renderTextBillingLimit(vm);
      } else {
        await renderBillingLimitInk(vm);
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}
