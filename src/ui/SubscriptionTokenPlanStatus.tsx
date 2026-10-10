import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import { colors } from './theme.js';
import { TokenPlanSeatDetails } from './TokenPlanSeatDetails.js';
import { formatTextTable } from '../output/format.js';
import type { TokenPlanStatusViewModel } from '../types/tokenplan-subscription.js';

export interface SubscriptionTokenPlanStatusInkProps {
  vm: TokenPlanStatusViewModel;
}

export function SubscriptionTokenPlanStatusInk({ vm }: SubscriptionTokenPlanStatusInkProps) {
  const hasData =
    (vm.editionSections?.length ?? 0) > 0 ||
    vm.header !== undefined ||
    (vm.seatLines?.length ?? 0) > 0;

  if (!hasData && vm.diagnostics.length > 0) {
    return (
      <Section title="Token Plan Subscription">
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={colors.error}>Token Plan subscription data unavailable</Text>
          {vm.diagnostics.map((diagnostic, index) => (
            <Text key={`${diagnostic.api}-${index}`} color={colors.muted}>
              · {diagnostic.errorMessage}
            </Text>
          ))}
        </Box>
      </Section>
    );
  }

  return (
    <Section title="Token Plan Subscription" footer={vm.footnote ?? undefined}>
      <Box flexDirection="column" paddingLeft={2}>
        {vm.editionSections?.map((section) => (
          <Box key={section.edition} flexDirection="column" marginBottom={1}>
            <Text bold>{section.title}</Text>
            {section.fields.map((field) => (
              <Text key={field.label}>
                {field.label.padEnd(18)}
                {field.value}
              </Text>
            ))}
          </Box>
        ))}
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
            <Text bold>SEAT SUMMARY</Text>
            <Text> </Text>
            <Text>
              {formatTextTable(
                ['SEAT TYPE', 'QUANTITY'],
                vm.seatLines.map((row) => [row.specType, row.seats]),
                0,
              )}
            </Text>
          </>
        )}
        {vm.seatDetails && <TokenPlanSeatDetails details={vm.seatDetails} titleGap={1} />}
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
