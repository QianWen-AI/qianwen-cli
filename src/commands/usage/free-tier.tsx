import React from 'react';
import type { Command } from 'commander';
import { createClient } from '../../api/client.js';
import type { UsageSummaryOptions } from '../../api/client.js';
import type { ResolvedFormat } from '../../types/config.js';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { resolveDateRange } from '../../utils/date.js';
import { handleError } from '../../utils/errors.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { buildUsageSummaryViewModel, type FreeTierRowViewModel } from '../../view-models/usage.js';
import { InteractiveTable } from '../../ui/InteractiveTable.js';
import { renderInteractive } from '../../ui/render.js';
import { withSpinner } from '../../ui/spinner.js';
import { buildProgressBar, theme } from '../../ui/theme.js';

/**
 * Register the `usage free-tier` action.
 */
export function usageFreeTierAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, options: Record<string, string>) {
    const config = getEffectiveConfig();
    const format: ResolvedFormat = resolveFormatFromCommand(this ?? cmd, config);

    try {
      await ensureAuthenticated();

      const dateRange = resolveDateRange({
        from: options.from,
        to: options.to,
        period: options.period,
      });

      const client = await createClient();
      const summaryOpts: UsageSummaryOptions = {
        from: dateRange.from,
        to: dateRange.to,
      };
      const data = await withSpinner(
        'Fetching free tier quota',
        () => client.getUsageSummary(summaryOpts),
        format,
      );

      if (format === 'json') {
        outputJSON({ free_tier: data.free_tier });
        return;
      }

      const vm = buildUsageSummaryViewModel(data);

      if (!vm.freeTier || vm.freeTier.rows.length === 0) {
        console.log('No free tier models found.');
        return;
      }

      // text mode: just print all rows
      if (format === 'text') {
        for (const row of vm.freeTier.rows) {
          if (row.isFreeOnly) {
            console.log(`${row.modelId}  Free access`);
          } else {
            console.log(
              `${row.modelId}  ${row.remaining} / ${row.total}  (${row.progressBar.label})`,
            );
          }
        }
        return;
      }

      // Table (TTY) — interactive paginated view
      await renderFreeTierInteractive(vm.freeTier.rows, vm.freeTier.totalCount);
    } catch (error) {
      handleError(error, format);
    }
  };
}

// ── Ink Rendering ─────────────────────────────────────────────────────

const PER_PAGE = 15;

function buildRow(row: FreeTierRowViewModel): Record<string, string> {
  if (row.isFreeOnly) {
    return {
      model: row.modelId,
      remaining: '—',
      total: '—',
      bar: theme.dim('Free access'),
    };
  }
  const bar = buildProgressBar(row.progressBar.percentage, 16, theme.data, false);
  const label = theme.label(row.progressBar.label);
  return {
    model: row.modelId,
    remaining: row.remaining,
    total: row.total,
    bar: `${bar}  ${label}`,
  };
}

async function renderFreeTierInteractive(
  rows: FreeTierRowViewModel[],
  totalCount: number,
): Promise<void> {
  const allBuilt = rows.map(buildRow);

  const columns = [
    { key: 'model', header: 'Model' },
    { key: 'remaining', header: 'Remaining' },
    { key: 'total', header: 'Total' },
    { key: 'bar', header: 'Quota Left' },
  ];

  const loadPage = async (page: number): Promise<Record<string, string>[]> => {
    const start = (page - 1) * PER_PAGE;
    return allBuilt.slice(start, start + PER_PAGE);
  };

  const initialRows = allBuilt.slice(0, PER_PAGE);

  await renderInteractive(
    <InteractiveTable
      columns={columns}
      totalItems={totalCount}
      perPage={PER_PAGE}
      loadPage={loadPage}
      initialRows={initialRows}
      title="Free Tier Quota"
      subtitle={`${totalCount} models  ·  sorted by urgency`}
    />,
  );
}
