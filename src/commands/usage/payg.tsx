import React from 'react';
import type { Command } from 'commander';
import { createClient } from '../../api/client.js';
import type { UsageSummaryOptions } from '../../api/client.js';
import type { ResolvedFormat } from '../../types/config.js';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { resolveDateRange, validateDateRange } from '../../utils/date.js';
import { handleError, invalidDateRangeError, HandledError } from '../../utils/errors.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import {
  buildUsageSummaryViewModel,
  type PayAsYouGoRowViewModel,
} from '../../view-models/usage.js';
import { InteractiveTable } from '../../ui/InteractiveTable.js';
import { renderInteractive } from '../../ui/render.js';
import { withSpinner } from '../../ui/spinner.js';
import { theme } from '../../ui/theme.js';

/**
 * Register the `usage payg` action.
 */
export function usagePaygAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, options: Record<string, string>) {
    const config = getEffectiveConfig();
    const format: ResolvedFormat = resolveFormatFromCommand(this ?? cmd, config);

    try {
      await ensureAuthenticated();

      const dateRange = resolveDateRange({
        from: options.from,
        to: options.to,
        days: options.days ? Number(options.days) : undefined,
        period: options.period,
      });

      // Validate date range to catch inverted dates early
      try {
        validateDateRange(dateRange.from, dateRange.to);
      } catch (err) {
        if (err instanceof Error && err.name === 'InvalidDateRangeError') {
          // Parse the structured error message
          const match = err.message.match(/INVALID_DATE_RANGE:from=(.+):to=(.+)/);
          if (match) {
            try {
              handleError(invalidDateRangeError(match[1], match[2]), format);
            } catch (e) {
              if (e instanceof HandledError) return; // handleError already printed
              throw e;
            }
          }
        }
        throw err;
      }

      const client = await createClient();
      const summaryOpts: UsageSummaryOptions = {
        from: dateRange.from,
        to: dateRange.to,
      };
      const data = await withSpinner(
        'Fetching pay-as-you-go usage',
        () => client.getUsageSummary(summaryOpts),
        format,
      );

      if (format === 'json') {
        outputJSON({ pay_as_you_go: data.pay_as_you_go });
        return;
      }

      const vm = buildUsageSummaryViewModel(data);
      const payg = vm.payAsYouGo;

      if (!payg || payg.isEmpty) {
        console.log(`No pay-as-you-go usage in ${dateRange.from} → ${dateRange.to}.`);
        return;
      }

      if (format === 'text') {
        for (const row of payg.rows) {
          console.log(`${row.modelId}  ${row.requests} req  ${row.usage}  ${row.cost}`);
        }
        console.log(`Total  ${payg.total.requests} req  ${payg.total.cost}`);
        return;
      }

      await renderPaygInteractive(payg.rows, payg.totalCount, payg.total, payg.period);
    } catch (error) {
      handleError(error, format);
    }
  };
}

// ── Ink Rendering ─────────────────────────────────────────────────────

const PER_PAGE = 15;

async function renderPaygInteractive(
  rows: PayAsYouGoRowViewModel[],
  totalCount: number,
  total: { requests: string; cost: string },
  period: string,
): Promise<void> {
  const columns = [
    { key: 'modelId', header: 'Model' },
    { key: 'requests', header: 'Requests' },
    { key: 'usage', header: 'Usage' },
    { key: 'cost', header: 'Cost' },
  ];

  const allBuilt = rows.map((row) => ({
    modelId: row.modelId,
    requests: row.requests,
    usage: row.usage,
    cost: row.cost,
  }));

  const loadPage = async (page: number): Promise<Record<string, string>[]> => {
    const start = (page - 1) * PER_PAGE;
    return allBuilt.slice(start, start + PER_PAGE);
  };

  const subtitle = `${totalCount} models  ${theme.symbols.dot}  ${period}`;

  const tableFooter = {
    modelId: theme.bold('Total'),
    requests: theme.bold(total.requests),
    usage: theme.bold('—'),
    cost: theme.bold(total.cost),
  };

  await renderInteractive(
    <InteractiveTable
      columns={columns}
      totalItems={totalCount}
      perPage={PER_PAGE}
      loadPage={loadPage}
      initialRows={allBuilt.slice(0, PER_PAGE)}
      footer={tableFooter}
      title="Pay-as-you-go"
      subtitle={subtitle}
    />,
  );
}
