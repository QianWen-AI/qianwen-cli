import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildSubscriptionStatusViewModel } from '../../view-models/subscription/index.js';
import { renderSubscriptionStatusInk } from '../../ui/SubscriptionStatus.js';
import { renderTextSubscriptionStatus } from '../../output/text/subscription.js';
import { handleError, HandledError } from '../../utils/errors.js';
import { TYPE_LABEL, ORDER_STATUS_LABEL } from '../../view-models/subscription/orders.js';

export function registerSubscriptionStatusCommand(parent: Command): void {
  const status = parent
    .command('status')
    .description('Aggregate subscription status across plans (token)')
    .option('--plan <kind>', 'Filter by plan: token')
    .option('--format <fmt>', 'Output format: card, json, text (default: auto)');

  status.action(subscriptionStatusAction(status));
}

export function subscriptionStatusAction(cmd: Command) {
  return async function (this: Command, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    let plan: 'token' | undefined;
    if (options.plan === 'token') plan = options.plan;

    try {
      ensureAuthenticated();
      const { subscriptionService } = createServices();
      const result = await withSpinner(
        'Loading subscription status',
        () => subscriptionService.getStatus(plan ? { plan } : {}),
        format,
      );

      if (format === 'json') {
        const { data, diagnostics } = result;
        if (data) {
          const jsonData = { ...data };
          if (jsonData.recentOrders && Array.isArray(jsonData.recentOrders)) {
            jsonData.recentOrders = jsonData.recentOrders.map((o) => ({
              ...o,
              orderType: TYPE_LABEL[(o.orderType ?? '').toLowerCase()] ?? o.orderType ?? '—',
              status: ORDER_STATUS_LABEL[(o.status ?? '').toUpperCase()] ?? o.status ?? '—',
            }));
          }
          outputJSON({ ...jsonData, diagnostics });
        } else {
          outputJSON({ data: null, diagnostics });
          process.exitCode = 1;
          throw new HandledError(1);
        }
        return;
      }

      const vm = buildSubscriptionStatusViewModel(result.data, result.diagnostics);
      if (format === 'text') {
        renderTextSubscriptionStatus(vm);
      } else {
        await renderSubscriptionStatusInk(vm);
      }
      if (result.data === null) {
        process.exitCode = 1;
        throw new HandledError(1);
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(error, format);
    }
  };
}
