import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { Table } from './Table.js';
import type { RechargeHistoryViewModel } from '../view-models/billing/recharge.js';
import { formatShanghaiDateTimeForDisplay } from '../utils/date.js';

/** Column layout shared by the static panel and the paginated table. */
export const RECHARGE_HISTORY_COLUMNS = [
  { key: 'time', header: 'Time' },
  { key: 'type', header: 'Type' },
  { key: 'channel', header: 'Channel' },
  { key: 'amount', header: 'Amount', align: 'right' as const },
];

/** Project one page of records onto the shared column layout. */
export function buildRechargeHistoryRows(vm: RechargeHistoryViewModel): Record<string, string>[] {
  return vm.records.map((record) => ({
    time: formatShanghaiDateTimeForDisplay(record.tradeTime),
    type: record.tradeType,
    channel: record.tradeChannel,
    amount: `${record.amount} ${record.currency}`,
  }));
}

/** Build the human-readable Shanghai date range shown above the table. */
export function buildRechargeHistorySubtitle(vm: RechargeHistoryViewModel): string {
  return `${formatShanghaiDateTimeForDisplay(vm.startTime)} → ${formatShanghaiDateTimeForDisplay(vm.endTime)}`;
}

/** Properties accepted by the recharge history panel. */
export interface RechargeHistoryInkProps {
  readonly vm: RechargeHistoryViewModel;
}

/** Render paginated recharge records without exposing backend transaction identifiers. */
export function RechargeHistoryInk({ vm }: RechargeHistoryInkProps): React.ReactElement {
  const rows = buildRechargeHistoryRows(vm);

  return (
    <Section
      title="Recharge History"
      subtitle={buildRechargeHistorySubtitle(vm)}
      footer={`Page ${vm.page} · ${vm.pageSize} per page · ${vm.totalCount} total`}
    >
      {rows.length === 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>No recharge records</Text>
        </Box>
      ) : (
        <Table columns={RECHARGE_HISTORY_COLUMNS} data={rows} />
      )}
    </Section>
  );
}
