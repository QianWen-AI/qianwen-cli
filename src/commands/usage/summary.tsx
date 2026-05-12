import React from 'react';
import type { Command } from 'commander';
import { Box, Text } from 'ink';
import { createClient } from '../../api/client.js';
import type { UsageSummaryOptions } from '../../api/client.js';
import type { ResolvedFormat } from '../../types/config.js';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { renderTextUsageSummary } from '../../output/text/usage.js';
import { resolveDateRange } from '../../utils/date.js';
import { handleError } from '../../utils/errors.js';
import { formatCmd } from '../../utils/runtime-mode.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import {
  buildUsageSummaryViewModel,
  type UsageSummaryViewModel,
  type FreeTierRowViewModel,
} from '../../view-models/usage.js';
import { Section, Table, theme, progressColor } from '../../ui/index.js';
import { buildProgressBar } from '../../ui/theme.js';
import { withSpinner } from '../../ui/spinner.js';
import { renderWithInk } from '../../ui/render.js';

/**
 * Register the `usage summary` action.
 */
export function usageSummaryAction(cmd: Command): (...args: any[]) => void | Promise<void> {
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
        'Fetching usage summary',
        () => client.getUsageSummary(summaryOpts),
        format,
      );

      if (format === 'json') {
        outputJSON(data);
        return;
      }

      const vm = buildUsageSummaryViewModel(data);

      if (format === 'text') {
        renderTextUsageSummary(vm);
        return;
      }

      // Table mode (TTY) — Ink rendering
      await renderInkUsageSummary(vm);
    } catch (error) {
      handleError(error, format);
    }
  };
}

// ── Ink Rendering ─────────────────────────────────────────────────────

async function renderInkUsageSummary(vm: UsageSummaryViewModel): Promise<void> {
  await renderWithInk(<UsageSummaryInk vm={vm} />);
}

function UsageSummaryInk({ vm }: { vm: UsageSummaryViewModel }) {
  return (
    <Box flexDirection="column">
      <Box paddingLeft={2}>
        <Text bold>{`Usage Summary  ${theme.symbols.dot}  ${vm.period}`}</Text>
      </Box>

      {vm.freeTier && (
        <Box marginTop={1}>
          <FreeTierSection data={vm.freeTier} />
        </Box>
      )}
      {vm.payAsYouGo && (
        <Box marginTop={1}>
          <PayAsYouGoSection data={vm.payAsYouGo} />
        </Box>
      )}
      {vm.tokenPlan && (
        <Box marginTop={1}>
          <TokenPlanSection data={vm.tokenPlan} />
        </Box>
      )}
    </Box>
  );
}

const FREE_TIER_PREVIEW_LIMIT = 10;

function FreeTierSection({ data }: { data: NonNullable<UsageSummaryViewModel['freeTier']> }) {
  const columns = [
    { key: 'modelId', header: 'Model' },
    { key: 'remaining', header: 'Remaining' },
    { key: 'total', header: 'Total' },
    { key: 'bar', header: 'Quota Left' },
  ];

  const visibleRows = data.rows.slice(0, FREE_TIER_PREVIEW_LIMIT);
  const hiddenCount = data.totalCount - visibleRows.length;
  const tableData = visibleRows.map((row) => buildFreeTierRowData(row));

  const footer =
    hiddenCount > 0
      ? `+ ${hiddenCount} more  ${theme.symbols.dot}  ${formatCmd('usage free-tier')} to browse all`
      : data.footer;

  return (
    <Section title="Free Tier Quota" subtitle={`${data.totalCount} models`} footer={footer}>
      <Table columns={columns} data={tableData} paddingLeft={0} />
    </Section>
  );
}

function buildFreeTierRowData(row: FreeTierRowViewModel): Record<string, string> {
  if (row.isFreeOnly) {
    return {
      modelId: row.modelId,
      remaining: '—',
      total: '—',
      bar: theme.dim('Free access'),
    };
  }

  const bar = buildProgressBar(row.progressBar.percentage, 16, theme.data, false);
  const label = theme.label(row.progressBar.label);

  return {
    modelId: row.modelId,
    remaining: row.remaining,
    total: row.total,
    bar: `${bar}  ${label}`,
  };
}

function TokenPlanSection({ data }: { data: NonNullable<UsageSummaryViewModel['tokenPlan']> }) {
  const columns = [
    { key: 'metric', header: '' },
    { key: 'value', header: '' },
  ];

  const bar = buildProgressBar(data.progressBar.percentage, 16, theme.data, false);
  const label = theme.label(data.progressBar.label);

  const rows = [
    { metric: 'Usage', value: data.usageDisplay },
    { metric: 'Quota Left', value: `${bar}  ${label}` },
    { metric: 'Status', value: data.status },
    { metric: 'Resets', value: data.resetDate },
  ];

  if (data.addonRemaining) {
    rows.push({ metric: 'Add-on', value: data.addonRemaining });
  }

  return (
    <Section title="Token Plan" subtitle={`${data.planName}  ${theme.symbols.dot}  ${data.status}`}>
      <Table columns={columns} data={rows} paddingLeft={0} />
    </Section>
  );
}

const PAYG_PREVIEW_LIMIT = 10;

function PayAsYouGoSection({ data }: { data: NonNullable<UsageSummaryViewModel['payAsYouGo']> }) {
  if (data.isEmpty) {
    return (
      <Section title="Pay-as-you-go" subtitle={data.period}>
        <Box paddingLeft={2}>
          <Text dimColor>No pay-as-you-go usage in this period.</Text>
        </Box>
      </Section>
    );
  }

  const columns = [
    { key: 'modelId', header: 'Model' },
    { key: 'usage', header: 'Usage' },
    { key: 'cost', header: 'Cost' },
  ];

  const visibleRows = data.rows.slice(0, PAYG_PREVIEW_LIMIT).map((row) => ({ ...row }));
  const hiddenCount = data.totalCount - visibleRows.length;

  const footer =
    hiddenCount > 0
      ? `+ ${hiddenCount} more  ${theme.symbols.dot}  ${formatCmd('usage payg')} to browse all`
      : undefined;

  const tableFooter = {
    modelId: theme.bold('Total'),
    usage: theme.bold('—'),
    cost: theme.bold(data.total.cost),
  };

  return (
    <Section
      title="Pay-as-you-go"
      subtitle={`${data.totalCount} models  ${theme.symbols.dot}  ${data.period}`}
      footer={footer}
    >
      <Table columns={columns} data={visibleRows} footer={tableFooter} paddingLeft={0} />
    </Section>
  );
}

// ── Progress Bar Text Helper (for Table cell rendering) ───────────────

function _renderProgressBarText(
  percentage: number,
  mode: 'remaining' | 'used',
  width: number = 20,
  label?: string,
): string {
  const clamped = Math.max(0, Math.min(100, percentage));
  const colorFn = progressColor(clamped, mode);
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = width - filledCount;
  const filledPart = theme.bar.filled.repeat(filledCount);
  const emptyPart = theme.bar.empty.repeat(emptyCount);
  const bar = colorFn(`${filledPart}${emptyPart}`);
  return label ? `${bar}  ${label}` : bar;
}
