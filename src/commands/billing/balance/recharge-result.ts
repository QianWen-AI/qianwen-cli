import React from 'react';
import type { Command } from 'commander';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { outputJSON, resolveFormatFromCommand } from '../../../output/format.js';
import { renderTextRechargeResult } from '../../../output/text/billing.js';
import { RECHARGE_POLL_TIMEOUT_MS } from '../../../services/billing-service.js';
import { createServices } from '../../../services/index.js';
import { RechargeResultInk, RechargeResultPollingInk } from '../../../ui/RechargeResult.js';
import { renderWithInk } from '../../../ui/render.js';
import { HandledError, handleError, invalidArgError } from '../../../utils/errors.js';
import { EXIT_CODES } from '../../../utils/exit-codes.js';
import { registerCommandInterrupt } from '../../../utils/command-interrupt.js';
import { buildRechargeResultViewModel } from '../../../view-models/billing/recharge.js';
import { toRechargeCliError } from './recharge-errors.js';

/** Register the hidden command that queries an existing recharge order. */
export function registerRechargeResultCommand(parent: Command): void {
  const command = parent
    .command('result', { hidden: true })
    .description('Query an existing recharge order')
    .requiredOption('--recharge-order-id <id>', 'Existing recharge order ID')
    .option(
      '--wait [seconds]',
      `Poll until terminal status; optionally set a positive timeout in seconds (default: ${RECHARGE_POLL_TIMEOUT_MS / 1_000})`,
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  command.action(rechargeResultAction(command));
}

/** Build the result action with SIGINT-to-AbortSignal cleanup. */
export function rechargeResultAction(cmd: Command) {
  return async function (this: Command): Promise<void> {
    const current = this ?? cmd;
    const format = resolveFormatFromCommand(current, getEffectiveConfig());
    const controller = new AbortController();
    const onInterrupt = () => controller.abort(new DOMException('SIGINT', 'AbortError'));
    process.on('SIGINT', onInterrupt);
    const unregisterInterrupt = registerCommandInterrupt(onInterrupt);
    let interrupted = false;
    try {
      const options = current.opts<{ rechargeOrderId?: string; wait?: true | string }>();
      const orderId = options.rechargeOrderId?.trim();
      if (!orderId) throw invalidArgError('--recharge-order-id is required.');
      const shouldWait = options.wait !== undefined;
      const deadlineAt = resolveRechargeWaitDeadline(options.wait);
      ensureAuthenticated();
      const billingService = createServices().billingService;
      const resultPromise = (
        shouldWait
          ? billingService.waitForRechargeResult({
              rechargeOrderId: orderId,
              signal: controller.signal,
              deadlineAt,
            })
          : billingService.getRechargeResult({
              rechargeOrderId: orderId,
              signal: controller.signal,
            })
      ).then(buildRechargeResultViewModel);
      // Observe immediate rejection before Ink effects subscribe; the original
      // promise is still awaited below and retains its error classification.
      void resultPromise.catch(() => undefined);
      if (format === 'table' && shouldWait) {
        await renderWithInk(
          React.createElement(RechargeResultPollingInk, {
            rechargeOrderId: orderId,
            resultPromise,
          }),
          { waitUntil: resultPromise },
        );
      }
      const output = await resultPromise;
      interrupted = output.reason === 'interrupted';
      if (format === 'json') outputJSON(output);
      else if (format === 'text') renderTextRechargeResult(output);
      else if (!shouldWait) {
        await renderWithInk(React.createElement(RechargeResultInk, { vm: output }));
      }
    } catch (error) {
      handleError(toRechargeCliError(error), format);
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException('Recharge result command stopped', 'AbortError'));
      }
      unregisterInterrupt();
      process.off('SIGINT', onInterrupt);
    }
    if (interrupted) throw new HandledError(EXIT_CODES.USER_INTERRUPT);
  };
}

/**
 * Resolve the optional --wait duration to one absolute command deadline.
 *
 * @param wait Commander value: true for the default or a user-provided number of seconds.
 * @returns The absolute epoch-millisecond deadline, or undefined when polling is disabled.
 */
function resolveRechargeWaitDeadline(wait: true | string | undefined): number | undefined {
  if (wait === undefined) return undefined;
  const now = Date.now();
  if (wait === true) return now + RECHARGE_POLL_TIMEOUT_MS;

  const value = wait.trim();
  const seconds = Number(value);
  const timeoutMs = seconds * 1_000;
  const deadlineAt = now + timeoutMs;
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(deadlineAt)
  ) {
    throw invalidArgError('--wait seconds must be a positive integer.');
  }
  return deadlineAt;
}
