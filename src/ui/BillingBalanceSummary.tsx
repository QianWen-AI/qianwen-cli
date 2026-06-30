import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import type { BalanceSummaryViewModel } from '../view-models/billing/balance.js';

export interface BillingBalanceSummaryProps {
  vm: BalanceSummaryViewModel;
}

export function BillingBalanceSummaryInk({ vm }: BillingBalanceSummaryProps) {
  return (
    <Section title="Balance Summary">
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          {'Available Amount'.padEnd(18)}
          <Text color="green" bold>
            {vm.displayAmount}
          </Text>
          {' '}
          {vm.currency}
        </Text>
      </Box>
    </Section>
  );
}

export async function renderBalanceSummaryInk(vm: BalanceSummaryViewModel): Promise<void> {
  await renderWithInk(<BillingBalanceSummaryInk vm={vm} />);
}
