import { CommanderError, type Command } from 'commander';
import React from 'react';
import { resolveFormatFromCommand, outputJSON } from '../../../output/format.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { openBrowser } from '../../../utils/open-browser.js';
import { renderBalanceRechargeInk } from '../../../ui/BillingBalanceRecharge.js';
import { RechargePaymentWaitInk } from '../../../ui/RechargePayment.js';
import {
  appendRechargeQrBlock,
  writeRechargePaymentBlock,
  writeRechargeQueryFailureBlock,
  writeRechargeResultBlock,
  writeRechargeWaitingNotice,
} from '../../../output/recharge-payment-block.js';
import { RechargeBalanceInk } from '../../../ui/RechargeBalance.js';
import { renderInteractive, renderWithInk } from '../../../ui/render.js';
import { renderTextRechargePayment } from '../../../output/text/billing.js';
import { createServices } from '../../../services/index.js';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { withSpinner } from '../../../ui/spinner.js';
import { HandledError, handleError, invalidArgError } from '../../../utils/errors.js';
import { EXIT_CODES } from '../../../utils/exit-codes.js';
import { parseRechargeAmount } from '../../../utils/amount.js';
import { addCommandErrorSupplement } from '../../../utils/commander-helpers.js';
import {
  buildBalanceSummaryViewModel,
  defaultViewContext,
} from '../../../view-models/billing/index.js';
import type { BalanceSummaryViewModel } from '../../../view-models/billing/index.js';
import {
  buildRechargePaymentViewModel,
  buildRechargeResultViewModel,
} from '../../../view-models/billing/recharge.js';
import type {
  RechargePaymentViewModel,
  RechargeResultFinalViewModel,
} from '../../../view-models/billing/recharge.js';
import { registerRechargeResultCommand } from './recharge-result.js';
import { toRechargeCliError } from './recharge-errors.js';

const RECHARGE_URL = 'https://platform.qianwenai.com/home/billing/overview?target=recharge';

/** Read the current terminal width for static output. */
function outputColumns(): number {
  return process.stdout.columns ?? 80;
}

/**
 * Reject a following flag before Commander can consume it as this option's value.
 *
 * Commander normally treats the next token as the value of a required option,
 * even when that token is another option. That turns `--channel --amount 0.01`
 * into an unrelated excess-argument error instead of identifying the missing
 * channel value.
 */
function rejectSwallowedOption(
  value: string,
  option: '--channel <channel>' | '--amount <amount>',
  supplement: string,
): string {
  const isHelpFlag = value === '-h' || value === '--help';
  if (!isHelpFlag && /^--?[A-Za-z]/u.test(value)) {
    throw new CommanderError(
      EXIT_CODES.GENERAL_ERROR,
      'commander.optionMissingArgument',
      `error: option '${option}' argument missing. ${supplement}`,
    );
  }
  return value;
}

/**
 * Read and show the current account balance after a recharge attempt ends.
 *
 * The lookup is informational and never changes the payment result. A failed
 * lookup still renders an unavailable panel instead of replacing the original
 * success, timeout, interruption, payment failure, or polling error.
 */
async function renderCurrentBalance(): Promise<void> {
  let vm: BalanceSummaryViewModel | undefined;
  try {
    const balance = await createServices().billingService.getAvailableBalance();
    vm = buildBalanceSummaryViewModel(balance, defaultViewContext());
  } catch {
    vm = undefined;
  }
  try {
    await renderWithInk(React.createElement(RechargeBalanceInk, { vm }));
  } catch {
    // Informational panel must never mask the primary payment result.
  }
}

/**
 * Show the created order, then wait for its outcome under a live status line.
 *
 * The order fields, exact payment link, and QR code are immutable once the
 * order exists, so they go out as plain main-screen text and the terminal owns
 * all line breaking. Foreground QR output survives terminal reflow without an
 * application redraw. Background and compact modes may append one QR after a
 * narrow terminal becomes wide enough. The Ink frame itself paints nothing, so
 * it cannot erase the order information above it.
 *
 * JSON and text stay single-shot because the payment Skill drives polling
 * itself through the dedicated hidden `recharge result` command; callers that
 * want blocking behavior use `recharge result --wait` explicitly.
 *
 * @param vm The freshly created order to display.
 * @returns The final safe payment-result view model.
 */
async function renderPaymentAndAwaitResult(
  vm: RechargePaymentViewModel,
): Promise<RechargeResultFinalViewModel> {
  const rechargeOrderId = vm.rechargeOrderId;
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException('Interrupted', 'AbortError'));
  // Only reachable outside a TTY, where no readline is intercepting the signal.
  process.on('SIGINT', cancel);
  const interactive = process.stdin.isTTY === true;
  try {
    const resultPromise = createServices()
      .billingService.waitForRechargeResult({ rechargeOrderId, signal: controller.signal })
      .then(buildRechargeResultViewModel);
    // The request starts before Ink mounts. Attach a rejection observer now so
    // an immediate transport failure is not reported as unhandled during that
    // short setup window; the command still awaits and classifies the original
    // promise below.
    void resultPromise.catch(() => undefined);
    let resultSettled = false;
    void resultPromise.then(
      () => {
        resultSettled = true;
      },
      () => {
        resultSettled = true;
      },
    );

    // Only an interactive frame can observe a later resize, so only then may the
    // shortfall message tell the user that widening the terminal helps.
    const { qrDrawn, qrAppendable } = writeRechargePaymentBlock(vm, outputColumns(), interactive);
    writeRechargeWaitingNotice(interactive);

    // Foreground mode always draws immediately. Background and compact modes
    // reach this callback only after an initial width failure; append exactly
    // once when the terminal first becomes wide enough.
    let qrSettled = qrDrawn || !qrAppendable;
    const onWidthChange = qrAppendable
      ? (columns: number) => {
          if (qrSettled) return;
          try {
            const outcome = appendRechargeQrBlock(vm.paymentUrl, columns);
            if (outcome !== 'width_insufficient') qrSettled = true;
          } catch {
            // QR output is best-effort. A partial/failed append must neither
            // retry on later resizes nor override the authoritative result.
            qrSettled = true;
          }
        }
      : undefined;

    const element = React.createElement(RechargePaymentWaitInk, {
      resultPromise,
      onCancel: cancel,
      interactive,
      onWidthChange,
    });
    try {
      if (interactive) {
        await renderInteractive(element, {
          altScreen: false,
          trailingNewline: true,
          protectStaticContent: true,
        });
      } else {
        await renderWithInk(element, { waitUntil: resultPromise });
      }
    } catch (error) {
      // The result passes through service and ViewModel promise reactions.
      // Wait one event-loop turn so an outcome settling alongside renderer
      // teardown takes precedence over the presentation error.
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The order and its link are already on the main screen, so a rendering
      // failure cannot hide them. Only rethrow when no outcome was reached.
      if (!resultSettled) throw error;
      // Otherwise the original result is awaited below so its status and exit
      // code stay authoritative even though the final render failed.
    }

    let result: RechargeResultFinalViewModel;
    try {
      result = await resultPromise;
    } catch (error) {
      try {
        writeRechargeQueryFailureBlock(outputColumns());
      } catch {
        // Preserve the original result-query error and its exit-code mapping.
      }
      throw error;
    }
    // A settled outcome no longer changes, so it belongs in static text rather
    // than the live frame. Presentation failure must not reclassify the result.
    try {
      writeRechargeResultBlock(result, outputColumns());
    } catch {
      // A confirmed payment outcome must not become a CLI failure merely because
      // the terminal rejected a best-effort write.
    }
    return result;
  } finally {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Recharge result rendering stopped', 'AbortError'));
    }
    process.off('SIGINT', cancel);
  }
}

export function registerBillingBalanceRechargeCommand(parent: Command): void {
  const recharge = parent
    .command('recharge')
    .description(
      'Open the recharge page in your browser when no flags are provided; use --channel and --amount to recharge in the terminal',
    )
    .option(
      '--channel <channel>',
      'Payment channel for terminal recharge (supported: alipay; requires --amount)',
      (value) => rejectSwallowedOption(value, '--channel <channel>', 'Available values: alipay'),
    )
    .option(
      '--amount <amount>',
      'Recharge amount in CNY, with at most two decimal places (requires --channel)',
      (value) =>
        rejectSwallowedOption(
          value,
          '--amount <amount>',
          'Enter a positive CNY amount with at most two decimal places.',
        ),
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  addCommandErrorSupplement(recharge, {
    code: 'commander.optionMissingArgument',
    message: "error: option '--channel <channel>' argument missing",
    supplement: 'Available values: alipay',
  });
  addCommandErrorSupplement(recharge, {
    code: 'commander.optionMissingArgument',
    message: "error: option '--amount <amount>' argument missing",
    supplement: 'Enter a positive CNY amount with at most two decimal places.',
  });

  recharge.action(balanceRechargeAction(recharge));
  registerRechargeResultCommand(recharge);
}

export function balanceRechargeAction(cmd: Command) {
  return async function (this: Command) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);
    const options = (this ?? cmd).opts<{ channel?: string; amount?: string }>();

    if (options.channel !== undefined || options.amount !== undefined) {
      let interrupted = false;
      let shouldRenderBalance = false;
      try {
        if (!options.channel || !options.amount) {
          throw invalidArgError('--channel and --amount must be provided together.');
        }
        if (options.channel !== 'alipay') {
          throw invalidArgError('--channel currently supports only alipay.');
        }
        let amount: string;
        try {
          amount = parseRechargeAmount(options.amount).amount;
        } catch (error) {
          throw invalidArgError(error instanceof Error ? error.message : String(error));
        }
        ensureAuthenticated();
        // Once a valid table-mode payment attempt starts, always end with the
        // current balance. It remains an informational snapshot and must not be
        // used to infer whether an unknown payment succeeded.
        shouldRenderBalance = format === 'table';
        const data = await withSpinner(
          'Creating recharge payment',
          () => createServices().billingService.createRecharge({ channel: 'alipay', amount }),
          format,
        );
        const vm = buildRechargePaymentViewModel(data);

        if (format === 'json') {
          outputJSON(vm);
        } else if (format === 'text') {
          renderTextRechargePayment(vm);
        } else {
          const result = await renderPaymentAndAwaitResult(vm);
          interrupted = result.reason === 'interrupted';
        }
      } catch (error) {
        handleError(toRechargeCliError(error), format);
      } finally {
        if (shouldRenderBalance) await renderCurrentBalance();
      }
      // Raise the interrupt only after the terminal state is restored, matching
      // the standalone result command's exit-code handling.
      if (interrupted) throw new HandledError(EXIT_CODES.USER_INTERRUPT);
      return;
    }

    // openBrowser resolves to the real launch result (false in sandboxed /
    // headless environments such as the Codex desktop app), and never rejects.
    const opened = await openBrowser(RECHARGE_URL);

    if (format === 'json') {
      outputJSON({
        rechargeUrl: RECHARGE_URL,
        opened,
        message: opened
          ? 'Recharge page opened in browser'
          : 'Could not open browser automatically',
      });
      return;
    }

    if (format === 'text') {
      if (opened) {
        console.log('Opening recharge page in your browser...');
        console.log(
          'If the browser did not open automatically, copy the link below and open it in your browser:',
        );
      } else {
        console.log('Please copy the link below and open it in your browser:');
      }
      console.log(RECHARGE_URL);
      return;
    }

    await renderBalanceRechargeInk(opened, RECHARGE_URL);
  };
}
