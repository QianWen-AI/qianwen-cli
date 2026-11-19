import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import { colors } from './theme.js';
import { useTerminalSize } from './useTerminalSize.js';
import type { TokenPlanListViewModel } from '../view-models/subscription/tokenplan-list.js';
import { TokenPlanDetailTables } from './TokenPlanDetailTables.js';

export function TokenPlanListInk({ vm }: { vm: TokenPlanListViewModel }) {
  const { columns } = useTerminalSize();
  const detailWidth = Math.max(1, columns);
  return (
    <Section title="TOKEN PLAN CATALOG" paddingLeft={0} maxWidth={columns} borderStyle="double">
      <Text>SIGNED IN {vm.data.authenticated ? 'yes' : 'no'}</Text>
      <Text>EDITION {vm.data.edition}</Text>
      <Text>BILLING CYCLE {vm.billingCycleLabel}</Text>
      {vm.sections.map((section) => (
        <Box key={section.edition} flexDirection="column" marginTop={1}>
          <Section title={section.title} paddingLeft={0} maxWidth={columns}>
            <Box flexDirection="column">
              {(section.type || section.subscription || section.subscriptionDetails.length > 0) && (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold>CURRENT SUBSCRIPTION</Text>
                  <Box flexDirection="column">
                    {section.type && <Text>TYPE {section.type}</Text>}
                    {section.subscription && <Text>{section.subscription}</Text>}
                    {section.subscriptionDetails.map((detail) => (
                      <Text key={detail}>{detail}</Text>
                    ))}
                  </Box>
                </Box>
              )}
              {(section.rows.length > 0 || section.cycleNote) && (
                <TokenPlanDetailTables
                  tables={[
                    {
                      title: 'PRICING',
                      headers: section.columns.map((column) => column.header),
                      rows: section.rows.map((row) =>
                        section.columns.map((column) => row[column.key]),
                      ),
                      emptyMessage: section.cycleNote ?? '',
                      layout: 'records',
                      ...(section.rows.length > 0 && section.cycleNote
                        ? { note: section.cycleNote }
                        : {}),
                    },
                  ]}
                  paddingLeft={0}
                  maxTotalWidth={detailWidth}
                  showNarrowLayoutHint
                />
              )}
              <TokenPlanDetailTables
                tables={section.details}
                paddingLeft={0}
                maxTotalWidth={detailWidth}
                showNarrowLayoutHint
              />
              {section.diagnostics.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold>NOTES</Text>
                  <Box flexDirection="column">
                    {section.diagnostics.map((entry, index) => (
                      <Text key={`${section.edition}-${index}`} color={colors.muted}>
                        {entry}
                      </Text>
                    ))}
                  </Box>
                </Box>
              )}
            </Box>
          </Section>
        </Box>
      ))}
    </Section>
  );
}

export async function renderTokenPlanListInk(vm: TokenPlanListViewModel): Promise<void> {
  await renderWithInk(<TokenPlanListInk vm={vm} />, { trailingNewline: false });
  // Ink inserts hard line breaks in long commands; append hints verbatim for copying.
  process.stdout.write(`\n${vm.note}\n`);
}
