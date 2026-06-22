import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import type { BillingSummaryViewModel } from '../view-models/billing/index.js';

export interface BillingSummaryInkProps {
  vm: BillingSummaryViewModel;
}

export function BillingSummaryInk({ vm }: BillingSummaryInkProps) {
  const subtitle = `${vm.cycle}${vm.chargeType !== undefined ? ` \u00B7 ${vm.chargeType}` : ''}`;
  return (
    <Section title="Bill Summary" subtitle={subtitle}>
      <Box flexDirection="column" paddingLeft={2}>
        {vm.fields.map((f) => (
          <Text key={f.label}>
            {f.label.padEnd(18)}
            {f.value}
          </Text>
        ))}
      </Box>
    </Section>
  );
}

export async function renderBillingSummaryInk(vm: BillingSummaryViewModel): Promise<void> {
  await renderWithInk(<BillingSummaryInk vm={vm} />);
}
