import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import type { BillingLimitViewModel } from '../view-models/billing/index.js';

export interface BillingLimitInkProps {
  vm: BillingLimitViewModel;
}

export function BillingLimitInk({ vm }: BillingLimitInkProps) {
  const status = vm.fields.find((f) => f.label === 'Status')?.value ?? '';
  const subtitle = `${status} \u00B7 ${vm.currency}`;
  return (
    <Section title="Usage Limit" subtitle={subtitle}>
      <Box flexDirection="column" paddingLeft={2}>
        {vm.fields.map((f) => (
          <Text key={f.label}>
            {f.label.padEnd(18)}
            {f.value}
          </Text>
        ))}
        <Text key="Currency">
          {'Currency'.padEnd(18)}
          {vm.currency}
        </Text>
      </Box>
    </Section>
  );
}

export async function renderBillingLimitInk(vm: BillingLimitViewModel): Promise<void> {
  await renderWithInk(<BillingLimitInk vm={vm} />);
}
