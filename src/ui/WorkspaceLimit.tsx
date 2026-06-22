import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import type { WorkspaceLimitViewModel } from '../view-models/workspace/index.js';

export interface WorkspaceLimitInkProps {
  vm: WorkspaceLimitViewModel;
}

export function WorkspaceLimitInk({ vm }: WorkspaceLimitInkProps) {
  return (
    <Section title="Workspace Limit">
      <Box flexDirection="column" paddingLeft={2}>
        <Text>Current {vm.current}</Text>
        <Text>Maximum {vm.max}</Text>
      </Box>
    </Section>
  );
}

export async function renderWorkspaceLimitInk(vm: WorkspaceLimitViewModel): Promise<void> {
  await renderWithInk(<WorkspaceLimitInk vm={vm} />);
}
