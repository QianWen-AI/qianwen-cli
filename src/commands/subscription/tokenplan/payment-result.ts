import type { Command } from 'commander';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { outputJSON, resolveFormatFromCommand } from '../../../output/format.js';
import { renderTextTokenPlanPaymentResult } from '../../../output/text/tokenplan-payment.js';
import { createServices } from '../../../services/index.js';
import type { ResolvedFormat } from '../../../types/config.js';
import type { TokenPlanPaymentResult } from '../../../types/tokenplan-payment.js';
import { renderTokenPlanPaymentResultInk } from '../../../ui/TokenPlanPaymentResult.js';
import { registerCommandInterrupt } from '../../../utils/command-interrupt.js';
import { HandledError, handleError, invalidArgError } from '../../../utils/errors.js';
import {
  buildTokenPlanPaymentResultViewModel,
  tokenPlanPaymentResultExitCode,
} from '../../../view-models/subscription/tokenplan-payment.js';

async function renderResult(result: TokenPlanPaymentResult, format: ResolvedFormat): Promise<void> {
  const vm = buildTokenPlanPaymentResultViewModel(result);
  if (format === 'json') outputJSON(vm.data);
  else if (format === 'text') renderTextTokenPlanPaymentResult(vm);
  else await renderTokenPlanPaymentResultInk(vm);
}

function isTerminalPaymentResult(result: TokenPlanPaymentResult | undefined): boolean {
  return (
    result?.status === 'succeeded' || result?.status === 'failed' || result?.status === 'cancelled'
  );
}

export function registerTokenPlanPaymentResultCommand(parent: Command): void {
  const command = parent
    .command('payment-result <order-id>')
    .description('Query an existing Token Plan payment order without creating or paying orders')
    .option('--wait', 'Poll every 3 seconds until the deadline')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  command.action(subscriptionTokenPlanPaymentResultAction(command));
}

export function subscriptionTokenPlanPaymentResultAction(cmd: Command) {
  return async function (this: Command, orderId: string): Promise<void> {
    const current = this ?? cmd;
    const format = resolveFormatFromCommand(current, getEffectiveConfig());
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    const unregister = registerCommandInterrupt(cancel);
    let result: TokenPlanPaymentResult | undefined;
    try {
      if (typeof orderId !== 'string' || !/^[1-9]\d*$/u.test(orderId)) {
        throw invalidArgError('order-id must be a positive decimal integer.');
      }
      ensureAuthenticated();
      const service = createServices().tokenPlanPaymentService;
      const options = current.opts<{ wait?: boolean }>();
      result = options.wait
        ? await service.waitForPaymentResult(orderId, { signal: controller.signal })
        : await service.getPaymentResult(orderId, controller.signal);
      if (controller.signal.aborted && !isTerminalPaymentResult(result)) {
        result =
          (await service.recoverPaymentResultFromOrders(orderId)) ??
          ({ orderId, status: 'unknown', reason: 'interrupted' } as const);
      }
      await renderResult(result, format);
      const exitCode = tokenPlanPaymentResultExitCode(result);
      if (exitCode !== 0) {
        throw new HandledError(exitCode);
      }
    } catch (error) {
      if (error instanceof HandledError) throw error;
      if (controller.signal.aborted && !isTerminalPaymentResult(result)) {
        if (!result) {
          await renderResult({ orderId, status: 'unknown', reason: 'interrupted' }, format);
        }
        throw new HandledError(130);
      }
      handleError(error, format);
    } finally {
      process.off('SIGINT', cancel);
      unregister();
      controller.abort();
    }
  };
}
