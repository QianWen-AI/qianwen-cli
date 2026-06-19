import { Option, type Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import {
  buildBillingBreakdownViewModel,
  defaultViewContext,
} from '../../view-models/billing/index.js';
import {
  renderBillingBreakdownInk,
  renderBillingBreakdownByPeriodsInk,
} from '../../ui/BillingBreakdown.js';
import {
  renderTextBillingBreakdown,
  renderTextBillingBreakdownByPeriods,
} from '../../output/text/billing.js';
import { handleError, CliError } from '../../utils/errors.js';
import { normalizeToFullDate, resolveDateRange } from '../../utils/date.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { createServices } from '../../services/index.js';
import {
  clampTop,
  defaultCurrentMonthCycle,
  defaultMonthRange,
  parseChargeType,
  parseGranularity,
  parseGroupBy,
} from './shared.js';

export function registerBillingBreakdownCommand(parent: Command): void {
  const breakdown = parent
    .command('breakdown')
    .description('Break down consumption by model / api-key')
    .option('--granularity <g>', 'Granularity: day | month', 'month')
    .addOption(
      new Option('--group-by <dim>', 'Grouping dimension: model | api-key')
        .choices(['model', 'api-key'])
        .default('model'),
    )
    .option('--from <date>', 'Start date (YYYY-MM-DD or YYYY-MM)')
    .option('--to <date>', 'End date (YYYY-MM-DD or YYYY-MM)')
    .option('--period <preset>', 'Period preset (month, last-month, week, ...)')
    .addOption(
      new Option('--charge-type <type>', 'Charge type filter: all (default), subscription, payg')
        .choices(['all', 'subscription', 'payg'])
        .default('all'),
    )
    .option('--top <n>', 'Top N rows', (v) => parseInt(v, 10), 10)
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  breakdown.action(billingBreakdownAction(breakdown));
}

export function billingBreakdownAction(cmd: Command) {
  return async function (this: Command, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    let groupBy: ReturnType<typeof parseGroupBy>;
    let chargeType: ReturnType<typeof parseChargeType>;
    let granularity: ReturnType<typeof parseGranularity>;
    let top: number;
    try {
      groupBy = parseGroupBy(options.groupBy);
      chargeType = parseChargeType(options.chargeType);
      granularity = parseGranularity(options.granularity, 'month');
      top = clampTop(options.top);
    } catch (err) {
      handleError(err, format);
      return;
    }

    let from: string;
    let to: string;
    if (options.from || options.to || options.period) {
      try {
        const range = resolveDateRange({
          from: typeof options.from === 'string' ? options.from : undefined,
          to: typeof options.to === 'string' ? options.to : undefined,
          period: typeof options.period === 'string' ? options.period : undefined,
        });
        from = range.from;
        to = range.to;
      } catch (err) {
        handleError(err, format);
        return;
      }
    } else {
      const range = granularity === 'month' ? defaultCurrentMonthCycle() : defaultMonthRange();
      from = range.from;
      to = range.to;
    }

    if (options.period && !options.from && !options.to) {
      const spanFrom = new Date(normalizeToFullDate(from, 'start'));
      const spanTo = new Date(normalizeToFullDate(to, 'end'));
      const spanDays = (spanTo.getTime() - spanFrom.getTime()) / (1000 * 60 * 60 * 24);

      const cmdInstance = this ?? cmd;
      const granularitySource = cmdInstance.getOptionValueSource('granularity');
      if (spanDays < 31) {
        if (granularitySource === 'cli' && granularity === 'month') {
          handleError(
            new CliError({
              code: 'INVALID_ARGUMENT',
              message:
                'Parameter conflict: --period less than a month is incompatible with --granularity month.',
              exitCode: EXIT_CODES.INVALID_ARGUMENT,
            }),
            format,
          );
          return;
        }
        if (granularitySource !== 'cli') {
          granularity = 'day';
        }
      } else if (granularitySource === 'cli' && granularity === 'day') {
        handleError(
          new CliError({
            code: 'INVALID_ARGUMENT',
            message:
              'Parameter conflict: --period spans 31+ days, incompatible with --granularity day (max 31 days).',
            exitCode: EXIT_CODES.INVALID_ARGUMENT,
          }),
          format,
        );
        return;
      }
    }

    const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
    const dayPattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    const validDate = (v: string) => monthPattern.test(v) || dayPattern.test(v);
    if (granularity === 'month') {
      if ((options.from && !validDate(from)) || (options.to && !validDate(to))) {
        handleError(
          new CliError({
            code: 'INVALID_ARGUMENT',
            message: 'Invalid date format. Expected YYYY-MM for month granularity.',
            exitCode: EXIT_CODES.INVALID_ARGUMENT,
          }),
          format,
        );
        return;
      }
    } else {
      if ((options.from && !dayPattern.test(from)) || (options.to && !dayPattern.test(to))) {
        handleError(
          new CliError({
            code: 'INVALID_ARGUMENT',
            message: 'Invalid date format. Expected YYYY-MM-DD for day granularity.',
            exitCode: EXIT_CODES.INVALID_ARGUMENT,
          }),
          format,
        );
        return;
      }
    }

    from = normalizeToFullDate(from, 'start');
    to = normalizeToFullDate(to, 'end');

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (granularity === 'month') {
      const monthDiff =
        (toDate.getFullYear() - fromDate.getFullYear()) * 12 +
        (toDate.getMonth() - fromDate.getMonth());
      if (monthDiff > 12) {
        handleError(new Error('Time range cannot exceed 12 months.'), format);
        return;
      }
    } else {
      const diffMs = toDate.getTime() - fromDate.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays > 31) {
        handleError(
          new CliError({
            code: 'INVALID_ARGUMENT',
            message: 'Time range cannot exceed 31 days for day granularity.',
            exitCode: EXIT_CODES.INVALID_ARGUMENT,
          }),
          format,
        );
        return;
      }
    }

    try {
      ensureAuthenticated();
      const services = createServices();

      const isMultiPeriod = detectMultiPeriod(from, to, granularity);

      if (isMultiPeriod) {
        const periodsData = await withSpinner(
          'Fetching consumption breakdown',
          () =>
            services.billingService.getConsumeBreakdownByPeriods({
              groupBy,
              from,
              to,
              chargeType,
              top,
              granularity,
            }),
          format,
        );

        if (format === 'json') {
          outputJSON(periodsData);
          return;
        }

        if (format === 'text') {
          renderTextBillingBreakdownByPeriods(periodsData, defaultViewContext());
        } else {
          await renderBillingBreakdownByPeriodsInk(periodsData, defaultViewContext());
        }
      } else {
        const data = await withSpinner(
          'Fetching consumption breakdown',
          () =>
            services.billingService.getConsumeBreakdown({
              groupBy,
              from,
              to,
              chargeType,
              top,
              granularity,
            }),
          format,
        );

        if (format === 'json') {
          outputJSON(data);
          return;
        }

        const vm = buildBillingBreakdownViewModel(data, defaultViewContext());
        if (format === 'text') {
          renderTextBillingBreakdown(vm);
        } else {
          await renderBillingBreakdownInk(vm);
        }
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}

function detectMultiPeriod(from: string, to: string, granularity: 'day' | 'month'): boolean {
  if (granularity === 'month') {
    const fromMonth = from.substring(0, 7);
    const toMonth = to.substring(0, 7);
    return fromMonth !== toMonth;
  }
  // day granularity: multi-period if dates span more than one day
  const fromDay = from.substring(0, 10);
  const toDay = to.substring(0, 10);
  return fromDay !== toDay;
}
