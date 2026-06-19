import { Option, type Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import {
  buildBillingSummaryViewModel,
  defaultViewContext,
} from '../../view-models/billing/index.js';
import { renderBillingSummaryInk } from '../../ui/BillingSummary.js';
import { renderTextBillingSummary } from '../../output/text/billing.js';
import { handleError } from '../../utils/errors.js';
import { createServices } from '../../services/index.js';
import { defaultCurrentMonthCycle, parseChargeType } from './shared.js';

const CYCLE_PATTERN = /^\d{4}-\d{2}$/;

export function registerBillingSummaryCommand(parent: Command): void {
  const summary = parent
    .command('summary')
    .description('Settled bill totals for an inclusive YYYY-MM cycle window')
    .option('--from <cycle>', 'Start cycle (YYYY-MM)')
    .option('--to <cycle>', 'End cycle (YYYY-MM)')
    .addOption(
      new Option('--charge-type <type>', 'Charge type filter: all (default), subscription, payg')
        .choices(['all', 'subscription', 'payg'])
        .default('all'),
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  summary.action(billingSummaryAction(summary));
}

export function billingSummaryAction(cmd: Command) {
  return async function (this: Command, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    const chargeType = parseChargeType(options.chargeType);
    const defaults = defaultCurrentMonthCycle();
    const from =
      typeof options.from === 'string' && CYCLE_PATTERN.test(options.from)
        ? options.from
        : defaults.from;
    const to =
      typeof options.to === 'string' && CYCLE_PATTERN.test(options.to) ? options.to : defaults.to;

    try {
      ensureAuthenticated();
      const services = createServices();
      const data = await withSpinner(
        'Fetching bill summary',
        () => services.billingService.getSettleBillSummary({ from, to, chargeType }),
        format,
      );

      if (format === 'json') {
        const jsonPayload = {
          period: data.period,
          chargeType: data.chargeType,
          currency: data.currency,
          cycles: data.cycles.map((c) => ({
            billingCycle: c.billingCycle,
            aftertaxAmount: c.aftertaxAmount,
          })),
          totals: {
            aftertaxAmount: data.totals.aftertaxAmount,
          },
        };
        outputJSON(jsonPayload);
        return;
      }

      const vm = buildBillingSummaryViewModel(data, defaultViewContext());
      if (format === 'text') {
        renderTextBillingSummary(vm);
      } else {
        await renderBillingSummaryInk(vm);
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}
