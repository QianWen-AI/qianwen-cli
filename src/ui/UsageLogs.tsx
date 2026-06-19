import React from 'react';
import { Section } from './Section.js';
import { Table } from './Table.js';
import type { Column } from './Table.js';
import { renderWithInk } from './render.js';
import { theme } from './theme.js';
import type {
  UsageLogsViewModel,
  UsageLogRowViewModel,
  UsageLogStatusColor,
} from '../view-models/usage-logs.js';

export const USAGE_LOG_COLUMNS: Column[] = [
  { key: 'time', header: 'Time' },
  { key: 'requestId', header: 'Request ID' },
  { key: 'statusCode', header: 'Status' },
  { key: 'model', header: 'Model' },
  { key: 'latency', header: 'Latency' },
  { key: 'usage', header: 'Usage' },
  { key: 'errorCode', header: 'Error' },
];

const EM_DASH = '\u2014';

export interface UsageLogsInkProps {
  vm: UsageLogsViewModel;
}

function colorize(value: string, statusColor: UsageLogStatusColor): string {
  switch (statusColor) {
    case 'green':
      return theme.success(value);
    case 'yellow':
      return theme.warning(value);
    case 'red':
      return theme.error(value);
    default:
      return value;
  }
}

/**
 * Map view-model rows to the `Record<string, string>` shape expected by
 * the Table / InteractiveTable renderers. Shared by the static Ink renderer
 * and the interactive paginated renderer so both surfaces stay aligned.
 */
export function buildUsageLogRows(
  rows: ReadonlyArray<UsageLogRowViewModel>,
): Record<string, string>[] {
  return rows.map((row) => ({
    time: row.time,
    requestId: row.requestId,
    statusCode: colorize(String(row.statusCode), row.statusColor),
    model: row.model,
    latency: row.latencyDisplay,
    usage: row.usage,
    errorCode: row.errorCode ?? EM_DASH,
  }));
}

export function UsageLogsInk({ vm }: UsageLogsInkProps) {
  const data = buildUsageLogRows(vm.items);

  const subtitle = vm.periodLabel || undefined;
  const footer = vm.isEmpty
    ? 'No call logs in this period.'
    : `${vm.totalCount} entries  \u00b7  Page ${vm.page} of ${vm.pageCount}`;

  const sectionProps: { title: string; subtitle?: string; footer: string } = {
    title: 'Usage Logs',
    footer,
  };
  if (subtitle) sectionProps.subtitle = subtitle;

  return (
    <Section {...sectionProps}>
      {!vm.isEmpty && <Table columns={USAGE_LOG_COLUMNS} data={data} paddingLeft={0} />}
    </Section>
  );
}

export async function renderUsageLogsInk(vm: UsageLogsViewModel): Promise<void> {
  await renderWithInk(<UsageLogsInk vm={vm} />);
}
