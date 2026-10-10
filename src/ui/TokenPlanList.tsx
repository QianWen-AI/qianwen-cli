import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { renderWithInk } from './render.js';
import { colors } from './theme.js';
import { visibleWidth } from './textWrap.js';
import { useTerminalSize } from './useTerminalSize.js';
import type { TokenPlanListViewModel } from '../view-models/subscription/tokenplan-list.js';

function UnwrappedLine({ value }: { value: string }) {
  return (
    <Box width={Math.max(1, visibleWidth(value))} flexShrink={0}>
      <Text>{value}</Text>
    </Box>
  );
}

export function TokenPlanListInk({ vm }: { vm: TokenPlanListViewModel }) {
  const { columns } = useTerminalSize();
  const tableWidth = Math.max(1, columns - 2);
  return (
    <Section title="Token Plan Prices" maxWidth={columns}>
      <Text>EDITION {vm.data.edition}</Text>
      <Text>BILLING CYCLE {vm.billingCycleLabel}</Text>
      {vm.sections.map((section) => (
        <Box key={section.edition} flexDirection="column" marginTop={1}>
          <Text bold>{section.title}</Text>
          {section.type && <Text>TYPE {section.type}</Text>}
          {section.subscription && <UnwrappedLine value={section.subscription} />}
          {section.subscriptionDetails.map((detail) => (
            <UnwrappedLine key={detail} value={detail} />
          ))}
          {section.cycleNote && <Text color={colors.warning}>{section.cycleNote}</Text>}
          {section.rows.length > 0 && (
            <Table
              columns={section.columns}
              data={section.rows}
              truncate
              maxTotalWidth={tableWidth}
            />
          )}
          {section.diagnostics.map((entry, index) => (
            <Text key={`${section.edition}-${index}`} color={colors.muted}>
              {entry}
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text>{vm.note}</Text>
      </Box>
    </Section>
  );
}

export async function renderTokenPlanListInk(vm: TokenPlanListViewModel): Promise<void> {
  await renderWithInk(<TokenPlanListInk vm={vm} />);
}
