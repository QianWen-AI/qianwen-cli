import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import type { SkillsInstallViewModel } from '../view-models/skills/index.js';

export interface SkillsInstallSummaryProps {
  vm: SkillsInstallViewModel;
}

const OUTCOME_COLORS: Record<SkillsInstallViewModel['outcome'], string> = {
  installed: 'green',
  updated: 'green',
  noop: 'yellow',
};

export function SkillsInstallSummary({ vm }: SkillsInstallSummaryProps) {
  // Product-spec V2 summary: exactly Skill / Mode|Agent / Location / Status.
  const rows: Array<[string, string]> = [
    ['Skill', vm.slug],
    [vm.modeLabel, vm.modeValue],
    ['Location', vm.targetDir],
    ['Status', vm.statusLabel],
  ];

  return (
    <Section title="Skills Install">
      <Box flexDirection="column">
        <Text color={OUTCOME_COLORS[vm.outcome]}>{vm.resultLine}</Text>
        <Box flexDirection="column" marginTop={1}>
          {rows.map(([label, value]) => (
            <Text key={label}>
              <Text dimColor>{label.padEnd(12)}</Text>
              {value}
            </Text>
          ))}
        </Box>
        {vm.downgradeWarning ? <Text color="yellow">warning: {vm.downgradeWarning}</Text> : null}
      </Box>
    </Section>
  );
}

export async function renderSkillsInstallInk(vm: SkillsInstallViewModel): Promise<void> {
  await renderWithInk(<SkillsInstallSummary vm={vm} />);
}
