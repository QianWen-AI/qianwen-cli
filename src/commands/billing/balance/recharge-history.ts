import React from 'react';
import type { Command } from 'commander';
import { ensureAuthenticated } from '../../../auth/credentials.js';
import { getEffectiveConfig } from '../../../config/manager.js';
import { outputJSON, resolveFormatFromCommand } from '../../../output/format.js';
import { renderTextRechargeHistory } from '../../../output/text/billing.js';
import { createServices } from '../../../services/index.js';
import { InteractiveTable } from '../../../ui/InteractiveTable.js';
import {
  RechargeHistoryInk,
  RECHARGE_HISTORY_COLUMNS,
  buildRechargeHistoryRows,
  buildRechargeHistorySubtitle,
} from '../../../ui/RechargeHistory.js';
import { renderInteractive, renderWithInk } from '../../../ui/render.js';
import { resolveRechargeHistoryRange } from '../../../utils/date.js';
import { handleError, invalidArgError } from '../../../utils/errors.js';
import { buildRechargeHistoryViewModel } from '../../../view-models/billing/recharge.js';
import { toRechargeCliError } from './recharge-errors.js';

/** Register the public recharge-history command. */
export function registerRechargeHistoryCommand(parent: Command): void {
  const command = parent
    .command('recharge-history')
    .description(
      'List recharge records.\n\n' +
        'Specify the time range in one of two ways:\n' +
        '  --range <range>\n' +
        '  --start-time <time> --end-time <time>\n' +
        'These options cannot be used together.',
    )
    .option('--range <range>', 'Calendar-day range in Asia/Shanghai: 1d, 3d, 7d, or 30d')
    .option('--start-time <time>', 'Inclusive start time; requires --end-time')
    .option('--end-time <time>', 'Inclusive end time; requires --start-time')
    .option('--page <page>', 'Page number', '1')
    .option('--page-size <page-size>', 'Records per page', '10')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  command.action(rechargeHistoryAction(command));
}

/** Build the recharge-history action for Commander and unit tests. */
export function rechargeHistoryAction(cmd: Command) {
  return async function (this: Command): Promise<void> {
    const current = this ?? cmd;
    const format = resolveFormatFromCommand(current, getEffectiveConfig());
    try {
      const options = current.opts<{
        range?: string;
        startTime?: string;
        endTime?: string;
        page?: string;
        pageSize?: string;
      }>();
      if (options.range && !['1d', '3d', '7d', '30d'].includes(options.range)) {
        throw invalidArgError('--range must be one of 1d, 3d, 7d, or 30d.');
      }
      const page = parsePositiveInteger(options.page ?? '1', '--page');
      const pageSize = parsePositiveInteger(options.pageSize ?? '10', '--page-size');
      let range: { startTime: number; endTime: number };
      try {
        range = resolveRechargeHistoryRange({
          range: options.range as '1d' | '3d' | '7d' | '30d' | undefined,
          startTime: options.startTime,
          endTime: options.endTime,
        });
      } catch (error) {
        throw invalidArgError(error instanceof Error ? error.message : String(error));
      }
      ensureAuthenticated();
      const billingService = createServices().billingService;
      const raw = await billingService.getRechargeHistory({ ...range, page, pageSize });
      const output = buildRechargeHistoryViewModel(raw);
      if (format === 'json') {
        outputJSON(output);
        return;
      }
      if (format === 'text') {
        renderTextRechargeHistory(output);
        return;
      }

      const initialRows = buildRechargeHistoryRows(output);
      // Paging needs a live keyboard and something to page through; without
      // either, the static panel already shows everything there is.
      if (!process.stdin.isTTY || !process.stdout.isTTY || output.totalCount <= pageSize) {
        await renderWithInk(React.createElement(RechargeHistoryInk, { vm: output }));
        return;
      }

      const loadPage = async (target: number): Promise<Record<string, string>[]> => {
        if (target === page) return initialRows;
        // Every page is re-queried over the same resolved range, so paging can
        // never slide the window and show a record twice.
        const next = await billingService.getRechargeHistory({
          ...range,
          page: target,
          pageSize,
        });
        return buildRechargeHistoryRows(buildRechargeHistoryViewModel(next));
      };
      await renderInteractive(
        React.createElement(InteractiveTable, {
          columns: RECHARGE_HISTORY_COLUMNS,
          totalItems: output.totalCount,
          perPage: pageSize,
          loadPage,
          initialPage: page,
          initialRows,
          title: 'Recharge History',
          subtitle: buildRechargeHistorySubtitle(output),
        }),
      );
    } catch (error) {
      handleError(toRechargeCliError(error), format);
    }
  };
}

/** Parse a strictly positive CLI integer. */
function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw invalidArgError(`${flag} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalidArgError(`${flag} must be a positive integer.`);
  }
  return parsed;
}
