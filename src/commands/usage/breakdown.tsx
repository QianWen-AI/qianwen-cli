import React from 'react';
import type { Command } from 'commander';
import { Box, Text } from 'ink';
import { createClient } from '../../api/client.js';
import type { UsageBreakdownOptions } from '../../api/client.js';
import type { ResolvedFormat } from '../../types/config.js';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { renderTextUsageBreakdown } from '../../output/text/usage.js';
import { resolveDateRange, validateDateRange } from '../../utils/date.js';
import {
  handleError,
  invalidArgError,
  invalidDateRangeError,
  HandledError,
} from '../../utils/errors.js';
import { validateModelId } from '../../utils/validate-model.js';
import { inferBillingUnitFromModel } from '../../utils/billing-unit.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { theme } from '../../ui/theme.js';
import { renderWithInk } from '../../ui/render.js';
import {
  buildUsageBreakdownViewModel,
  type UsageBreakdownViewModel,
} from '../../view-models/usage.js';
import { Table } from '../../ui/index.js';
import { withSpinner } from '../../ui/spinner.js';

/**
 * Register the `usage breakdown` action.
 */
export function usageBreakdownAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, options: Record<string, any>) {
    const config = getEffectiveConfig();
    const format: ResolvedFormat = resolveFormatFromCommand(this ?? cmd, config);

    if (!options.model) {
      handleError(invalidArgError('Missing required option: --model <id>'), format);
      return;
    }

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

      const granularity = options.granularity ?? 'day';
      const allowedGranularities = ['day', 'month', 'quarter'];
      if (granularity && !allowedGranularities.includes(granularity)) {
        handleError(
          invalidArgError(`Invalid granularity '${granularity}'. Allowed: day, month, quarter`),
          format,
        );
        return;
      }

      const client = await createClient();

      // Pre-validate model ID against the registry so a typo surfaces a
      // structured MODEL_NOT_FOUND (with did-you-mean) instead of a silently
      // empty breakdown table. The matched Model is reused to derive the
      // billing-unit and pick the right column headers.
      const model = await withSpinner(
        'Validating model',
        () => validateModelId(client, options.model),
        format,
      );
      const billingUnit = inferBillingUnitFromModel(model);

      const breakdownOpts: UsageBreakdownOptions = {
        model: options.model,
        granularity,
        from: dateRange.from,
        to: dateRange.to,
      };
      const data = await withSpinner(
        'Fetching usage breakdown',
        () => client.getUsageBreakdown(breakdownOpts),
        format,
      );

      if (format === 'json') {
        outputJSON(data);
        return;
      }

      const vm = buildUsageBreakdownViewModel(data, { billingUnitOverride: billingUnit });

      if (format === 'text') {
        renderTextUsageBreakdown(vm);
        return;
      }

      // Table mode (TTY) — Ink rendering
      await renderInkBreakdown(vm);
    } catch (error) {
      handleError(error, format);
    }
  };
}

// ── Ink Rendering ─────────────────────────────────────────────────────

async function renderInkBreakdown(vm: UsageBreakdownViewModel): Promise<void> {
  await renderWithInk(<BreakdownInk vm={vm} />);
}

function BreakdownInk({ vm }: { vm: UsageBreakdownViewModel }) {
  const title = `${vm.title}  ${theme.symbols.dot}  ${vm.modelId}  ${theme.symbols.dot}  ${vm.period}`;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text bold>{title}</Text>

      {vm.subtitle && <Text dimColor>{`  ${vm.subtitle}`}</Text>}

      {vm.emptyHint && <Text dimColor>{vm.emptyHint}</Text>}

      {vm.note && (
        <Box flexDirection="column" marginTop={1}>
          {vm.note.split('\n').map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <BreakdownTable vm={vm} />
      </Box>
    </Box>
  );
}

function BreakdownTable({ vm }: { vm: UsageBreakdownViewModel }) {
  const columns = vm.columns.map((col) => ({
    key: col.key,
    header: col.header,
    align: col.align || ('left' as 'left' | 'right'),
  }));

  const currentLabel = '← current';

  const tableRows = vm.rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const col of vm.columns) {
      if (col.key === 'period') {
        cells.period = row.isCurrent ? `${row.period}  ${currentLabel}` : row.period;
      } else {
        cells[col.key] = row.cells[col.key] ?? '—';
      }
    }
    return cells;
  });

  // Total row
  const totalCells: Record<string, string> = {};
  for (const col of vm.columns) {
    if (col.key === 'period') {
      totalCells.period = 'Total';
    } else {
      totalCells[col.key] = vm.total.cells[col.key] ?? '—';
    }
  }

  return <Table columns={columns} data={tableRows} footer={totalCells} paddingLeft={0} />;
}
