/**
 * Text mode renderers for usage commands.
 * Pure text output (no ANSI colors, no borders) for --format text.
 * Receives ViewModel as input.
 */

import type {
  UsageSummaryViewModel,
  UsageBreakdownViewModel,
  PayAsYouGoRowViewModel,
} from '../../view-models/usage.js';
import type { UsageLogsViewModel } from '../../view-models/usage-logs.js';
import { formatTextTable } from '../text.js';

// ── Usage Summary Text Renderer ──────────────────────────────────────

export function renderTextUsageSummary(vm: UsageSummaryViewModel): void {
  const lines: string[] = [];

  lines.push(`  Usage Summary  ·  ${vm.period}`);
  lines.push('');

  // Free Tier section
  if (vm.freeTier) {
    lines.push(formatSectionLine('Free Tier Quota'));
    lines.push('');
    lines.push(renderFreeTierTable(vm.freeTier));
    lines.push(`  ${vm.freeTier.footer}`);
    lines.push('');
  }

  // Pay-as-you-go section
  if (vm.payAsYouGo) {
    lines.push(formatSectionLine('Pay-as-you-go', vm.payAsYouGo.period));
    lines.push('');

    if (vm.payAsYouGo.isEmpty) {
      lines.push('  No pay-as-you-go usage in this period.');
    } else {
      lines.push(renderPayAsYouGoTable(vm.payAsYouGo));
    }
    lines.push('');
  }

  // Token Plan section
  if (vm.tokenPlan) {
    const tp = vm.tokenPlan;
    lines.push(formatSectionLine('Token Plan', `${tp.planName}  ·  ${tp.status}`));
    lines.push('');
    lines.push(`  Usage:     ${tp.usageDisplay}`);
    lines.push(`  Quota Left: ${tp.progressBar.label}`);
    lines.push(`  Status:    ${tp.status}`);
    lines.push(`  Resets:    ${tp.resetDate}`);
    if (tp.addonRemaining) {
      lines.push(`  Add-on:    ${tp.addonRemaining}`);
    }
    lines.push('');
  }

  console.log(lines.join('\n'));
}

function formatSectionLine(title: string, subtitle?: string): string {
  const width = 80;
  const titlePart = subtitle ? `${title}  ·  ${subtitle}` : title;
  const dashes = '─'.repeat(Math.max(0, width - titlePart.length - 4));
  return `  ── ${titlePart}${dashes}`;
}

function renderFreeTierTable(section: NonNullable<UsageSummaryViewModel['freeTier']>): string {
  const headers = ['Model', 'Remaining', 'Total', 'Quota Left'];
  const rows = section.rows.map((row) => {
    if (row.isFreeOnly) {
      return [row.modelId, '—', '—', 'FreeTier Only'];
    }
    return [row.modelId, row.remaining, row.total, row.progressBar.label];
  });

  return '  ' + formatTextTable(headers, rows, 0).replace(/^ {2}/gm, '');
}

function renderPayAsYouGoTable(section: NonNullable<UsageSummaryViewModel['payAsYouGo']>): string {
  const headers = ['Model', 'Usage', 'Cost'];
  const rows = section.rows.map((row) => [row.modelId, row.usage, row.cost]);

  // Add total row
  rows.push(['Total', '—', section.total.cost]);

  return '  ' + formatTextTable(headers, rows, 0).replace(/^ {2}/gm, '');
}

// ── Usage Breakdown Text Renderer ────────────────────────────────────

export function renderTextUsageBreakdown(vm: UsageBreakdownViewModel): void {
  const lines: string[] = [];

  lines.push(`  ${vm.title}  ·  ${vm.modelId}  ·  ${vm.period}`);

  if (vm.subtitle) {
    lines.push(`  ${vm.subtitle}`);
  }

  if (vm.emptyHint) {
    lines.push(`  ${vm.emptyHint}`);
  }

  if (vm.note) {
    lines.push('');
    lines.push(
      vm.note
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }

  lines.push('');

  // Build table
  const currentLabel = '← current';
  const headers = vm.columns.map((c) => c.header);
  const rows = vm.rows.map((row) => {
    const cells = [row.period];
    for (const col of vm.columns) {
      if (col.key !== 'period') {
        cells.push(row.cells[col.key] ?? '');
      }
    }
    // Add current marker
    if (row.isCurrent) {
      const periodIdx = vm.columns.findIndex((c) => c.key === 'period');
      if (periodIdx >= 0) {
        cells[0] = `${cells[0]}  ${currentLabel}`;
      }
    }
    return cells;
  });

  // Total row
  const totalCells = [vm.total.cells.period];
  for (const col of vm.columns) {
    if (col.key !== 'period') {
      totalCells.push(vm.total.cells[col.key] ?? '—');
    }
  }
  rows.push(totalCells);

  lines.push('  ' + formatTextTable(headers, rows, 0).replace(/^ {2}/gm, ''));
  lines.push('');

  console.log(lines.join('\n'));
}

// ── Usage PAYG Text Renderer ─────────────────────────────────────────

/**
 * Render the standalone `usage payg` text output. Mirrors the table-mode
 * column layout (Model / Usage / Cost) so users see the same headers
 * regardless of whether they opted into `--format text`.
 */
export function renderTextUsagePayg(
  items: ReadonlyArray<PayAsYouGoRowViewModel>,
  total: { cost: string },
): void {
  const headers = ['Model', 'Usage', 'Cost'];
  const rows = items.map((row) => [row.modelId, row.usage, row.cost]);
  rows.push(['Total', '\u2014', total.cost]);
  console.log(formatTextTable(headers, rows, 0));
}

// ── Usage Logs Text Renderer ─────────────────────────────────────────

export function renderTextUsageLogs(vm: UsageLogsViewModel): void {
  const lines: string[] = [];
  const header = vm.periodLabel ? `  Usage Logs  \u00b7  ${vm.periodLabel}` : '  Usage Logs';
  lines.push(header);
  lines.push('');

  if (vm.isEmpty) {
    lines.push('  No call logs in this period.');
    console.log(lines.join('\n'));
    return;
  }

  const headers = ['Time', 'Request ID', 'Status', 'Model', 'Latency', 'Usage', 'Error'];
  const rows = vm.items.map((row) => [
    row.time,
    row.requestId,
    String(row.statusCode),
    row.model,
    row.latencyDisplay,
    row.usage,
    row.errorCode ?? '\u2014',
  ]);
  lines.push('  ' + formatTextTable(headers, rows, 0).replace(/^ {2}/gm, ''));
  lines.push('');
  lines.push(`  ${vm.totalCount} entries  \u00b7  Page ${vm.page} of ${vm.pageCount}`);
  console.log(lines.join('\n'));
}
