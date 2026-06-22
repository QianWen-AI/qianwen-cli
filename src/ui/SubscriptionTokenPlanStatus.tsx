import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import { colors } from './theme.js';
import type { TokenPlanStatusViewModel } from '../types/tokenplan-subscription.js';

export interface SubscriptionTokenPlanStatusInkProps {
  vm: TokenPlanStatusViewModel;
}

export function SubscriptionTokenPlanStatusInk({ vm }: SubscriptionTokenPlanStatusInkProps) {
  const hasData = vm.header !== undefined || (vm.seatLines && vm.seatLines.length > 0);

  if (!hasData && vm.diagnostics.length > 0) {
    return (
      <Section title="Token Plan Subscription">
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={colors.error}>Token Plan subscription data unavailable</Text>
          {vm.diagnostics.map((d) => (
            <Text key={d.api} color={colors.muted}>
              · {d.api}: {d.errorCode} {d.errorMessage}
            </Text>
          ))}
        </Box>
      </Section>
    );
  }

  return (
    <Section title="Token Plan Subscription" footer={vm.footnote ?? undefined}>
      <Box flexDirection="column" paddingLeft={2}>
        {vm.header && (
          <>
            <Text>
              {'Product'.padEnd(16)}
              {vm.header.product}
            </Text>
            <Text>
              {'Period'.padEnd(16)}
              {vm.header.period}
            </Text>
            <Text>
              {'Auto-Renew'.padEnd(16)}
              {vm.header.autoRenew}
            </Text>
            <Text>
              {'Renewable'.padEnd(16)}
              {vm.header.renewable}
            </Text>
          </>
        )}
        {vm.seatLines && vm.seatLines.length > 0 && (
          <>
            <Text> </Text>
            <Text bold>Seat Summary</Text>
            <Text>
              {'  '}
              {'Type'.padEnd(12)}
              {'Seats'.padEnd(10)}
              {'Total'.padEnd(20)}
              {'Surplus'.padEnd(20)}
              {'Next Cycle'.padEnd(12)}
            </Text>
            {vm.seatLines.map((row) => (
              <Text key={row.specType}>
                {'  '}
                {row.specType.padEnd(12)}
                {row.seats.padEnd(10)}
                {row.totalValue.padEnd(20)}
                {row.surplusValue.padEnd(20)}
                {row.nextCycleFlushTime.padEnd(12)}
              </Text>
            ))}
            {vm.totalLine && (
              <Text bold>
                {'  '}
                {vm.totalLine.specType.padEnd(12)}
                {vm.totalLine.seats.padEnd(10)}
                {vm.totalLine.totalValue.padEnd(20)}
                {vm.totalLine.surplusValue.padEnd(20)}
                {vm.totalLine.nextCycleFlushTime.padEnd(12)}
              </Text>
            )}
          </>
        )}
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

export async function renderSubscriptionTokenPlanStatusInk(
  vm: TokenPlanStatusViewModel,
): Promise<void> {
  await renderWithInk(<SubscriptionTokenPlanStatusInk vm={vm} />);
}
