import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';

interface BalanceRechargeProps {
  opened: boolean;
  url: string;
}

function BalanceRechargePanel({ opened, url }: BalanceRechargeProps) {
  return (
    <Section title="Recharge">
      <Box flexDirection="column" paddingLeft={2}>
        {opened ? (
          <Text color="green">{'\u2713'} Opening recharge page in your browser...</Text>
        ) : (
          <Text color="yellow">{'\u26A0'} Could not open browser automatically</Text>
        )}
        <Text>{' '}</Text>
        <Text>
          {opened
            ? 'If the browser did not open, copy the link below:'
            : 'Please copy the link below and open it in your browser:'}
        </Text>
        <Text color="cyan">{url}</Text>
      </Box>
    </Section>
  );
}

export async function renderBalanceRechargeInk(opened: boolean, url: string): Promise<void> {
  await renderWithInk(<BalanceRechargePanel opened={opened} url={url} />);
}
