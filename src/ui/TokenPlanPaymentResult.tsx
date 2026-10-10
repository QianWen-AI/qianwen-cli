import React from 'react';
import { Text } from 'ink';
import type { TokenPlanPaymentResultViewModel } from '../types/tokenplan-payment.js';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';

export function TokenPlanPaymentResultInk({ vm }: { vm: TokenPlanPaymentResultViewModel }) {
  return (
    <Section title="Token Plan Payment Result" footer={vm.note}>
      {vm.fields.map((field) => (
        <Text key={field.label}>
          {field.label}: {field.value}
        </Text>
      ))}
    </Section>
  );
}

export async function renderTokenPlanPaymentResultInk(
  vm: TokenPlanPaymentResultViewModel,
): Promise<void> {
  await renderWithInk(<TokenPlanPaymentResultInk vm={vm} />);
}
