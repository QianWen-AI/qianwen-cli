import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildSubscriptionStatusViewModel } from '../../view-models/subscription/index.js';
import { formatSubscriptionStatusJson } from '../../view-models/subscription/shared.js';
import { renderSubscriptionStatusInk } from '../../ui/SubscriptionStatus.js';
import { renderTextSubscriptionStatus } from '../../output/text/subscription.js';
import { CliError, handleError, HandledError } from '../../utils/errors.js';
import { TYPE_LABEL, ORDER_STATUS_LABEL } from '../../view-models/subscription/orders.js';

function totalFailureError(exitCode: 1 | 2 | 3 | 4): CliError {
  if (exitCode === 2)
    return new CliError({
      code: 'AUTH_REQUIRED',
      message: 'Subscription status authentication failed. Run: qianwen auth login',
      exitCode,
    });
  if (exitCode === 3)
    return new CliError({
      code: 'NETWORK_ERROR',
      message: 'Subscription status requests failed. Check your network connection.',
      exitCode,
    });
  if (exitCode === 4)
    return new CliError({
      code: 'CONFIG_ERROR',
      message: 'Subscription status configuration or response protocol is invalid.',
      exitCode,
    });
  return new CliError({
    code: 'SUBSCRIPTION_STATUS_UNAVAILABLE',
    message: 'No subscription status data could be confirmed.',
    exitCode,
  });
}

export function registerSubscriptionStatusCommand(parent: Command): void {
  const status = parent
    .command('status')
    .description('Aggregate individual and team Token Plan subscription status')
    .option('--plan <kind>', 'Filter by plan: token')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  status.action(subscriptionStatusAction(status));
}

export function subscriptionStatusAction(cmd: Command) {
  return async function (this: Command, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      let plan: 'token' | undefined;
      if (options.plan === 'token') {
        plan = options.plan;
      } else if (options.plan !== undefined) {
        throw new CliError({
          code: 'INVALID_ARGUMENT',
          message: '--plan must be token.',
          exitCode: 1,
        });
      }
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
          outputJSON(formatSubscriptionStatusJson({ ...jsonData, diagnostics }));
        } else {
          outputJSON({ data: null, diagnostics });
          handleError(totalFailureError(result.failureExitCode ?? 1), format);
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
        handleError(totalFailureError(result.failureExitCode ?? 1), format);
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(error, format);
    }
  };
}
