import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import { colors, theme } from './theme.js';
import type { SeatStatusColor, TokenPlanSeatsViewModel } from '../types/tokenplan-subscription.js';

export interface SubscriptionTokenPlanSeatsInkProps {
  vm: TokenPlanSeatsViewModel;
}

const COLUMNS = [
  { key: 'instanceCode', header: 'Instance' },
  { key: 'specType', header: 'Type' },
  { key: 'status', header: 'Status' },
  { key: 'memberIdMasked', header: 'Member' },
  { key: 'totalValue', header: 'Cycle Total', align: 'right' as const },
  { key: 'surplusValue', header: 'Cycle Left', align: 'right' as const },
  { key: 'assignment', header: 'Assignment' },
];

function colorizeStatus(label: string, color: SeatStatusColor): string {
  switch (color) {
    case 'green':
      return theme.success(label);
    case 'orange':
      return theme.warning(label);
    case 'gray':
      return theme.muted(label);
    default:
      return label;
  }
}

export function SubscriptionTokenPlanSeatsInk({ vm }: SubscriptionTokenPlanSeatsInkProps) {
  const headerLine = vm.header ? `Total: ${vm.header.total}   Filter: ${vm.header.filter}` : '';
  const footerLine = vm.footer ? `${vm.footer.pagination}   ${vm.footer.total}` : undefined;

  if (!vm.rows || vm.rows.length === 0) {
    return (
      <Section title="Token Plan Seats" footer={footerLine ?? vm.footnote ?? undefined}>
        <Box flexDirection="column" paddingLeft={2}>
          {headerLine && <Text>{headerLine}</Text>}
          <Text color={colors.muted}>{vm.emptyPlaceholder ?? 'No seats found.'}</Text>
          {vm.warnings && vm.warnings.length > 0 && (
            <>
              <Text> </Text>
              {vm.warnings.map((w, idx) => (
                <Text key={idx} color={colors.warning}>
                  {w}
                </Text>
              ))}
            </>
          )}
        </Box>
      </Section>
    );
  }

  const tableData = vm.rows.map((row) => ({
    instanceCode: row.instanceCode,
    specType: row.specType,
    status: colorizeStatus(row.status, row.statusColor),
    memberIdMasked: row.memberIdMasked,
    totalValue: row.totalValue,
    surplusValue: row.surplusValue,
    assignment: row.assignment,
  }));

  return (
    <Section title="Token Plan Seats" footer={footerLine ?? vm.footnote ?? undefined}>
      <Box flexDirection="column" paddingLeft={2}>
        {headerLine && <Text>{headerLine}</Text>}
        <Text> </Text>
        <Table columns={COLUMNS} data={tableData} paddingLeft={0} />
        {vm.warnings && vm.warnings.length > 0 && (
          <>
            <Text> </Text>
            {vm.warnings.map((w, idx) => (
              <Text key={idx} color={colors.warning}>
                {w}
              </Text>
            ))}
          </>
        )}
      </Box>
    </Section>
  );
}

export async function renderSubscriptionTokenPlanSeatsInk(
  vm: TokenPlanSeatsViewModel,
): Promise<void> {
  await renderWithInk(<SubscriptionTokenPlanSeatsInk vm={vm} />);
}
