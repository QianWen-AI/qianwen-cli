/**
 * Slug-conflict override confirmation prompt for `skills install`.
 *
 * Shown when the target directory is managed by a different skill and the
 * user is in an interactive TTY terminal. Mirrors the `PackInstallConfirm`
 * pattern (Section container + info rows + Y/n key handling).
 */

import React from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Section } from './Section.js';
import { renderInteractive } from './render.js';
import type { SlugConflictInfo } from '../services/skills-install-service.js';

export interface SkillOverrideConfirmProps {
  info: SlugConflictInfo;
  toInstallSlug: string;
  toInstallVersion: string;
  onResult: (confirmed: boolean) => void;
}

export function SkillOverrideConfirm({
  info,
  toInstallSlug,
  toInstallVersion,
  onResult,
}: SkillOverrideConfirmProps) {
  const { exit } = useApp();

  useInput((rawInput, key) => {
    const input = rawInput.replace(/[\r\n]+$/, '');
    if (input === 'c' && key.ctrl) {
      onResult(false);
      exit();
      return;
    }
    if (key.escape) {
      onResult(false);
      exit();
      return;
    }
    if (key.return || input === 'y' || input === 'Y') {
      onResult(true);
      exit();
      return;
    }
    if (input === 'n' || input === 'N') {
      onResult(false);
      exit();
    }
  });

  const rows: Array<[string, string]> = [
    ['Installed', `${info.existingSlug} ${info.existingVersion}`],
    ['To install', `${toInstallSlug} ${toInstallVersion}`],
    ['Location', info.targetDir],
    ['Effect', 'The existing skill will be completely replaced'],
  ];

  return (
    <Section title="Skill directory conflict">
      <Box flexDirection="column" paddingLeft={2} marginTop={1}>
        <Text color="yellow">The target directory is already occupied by a different skill.</Text>
        <Box flexDirection="column" marginTop={1}>
          {rows.map(([label, value]) => (
            <Text key={label}>
              <Text dimColor>{label.padEnd(14)}</Text>
              {value}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text>Proceed? (Y/n)</Text>
        </Box>
      </Box>
    </Section>
  );
}

export async function promptSkillOverrideConfirm(
  info: SlugConflictInfo,
  toInstallSlug: string,
  toInstallVersion: string,
): Promise<boolean> {
  let confirmed = false;

  const element = React.createElement(SkillOverrideConfirm, {
    info,
    toInstallSlug,
    toInstallVersion,
    onResult: (value: boolean) => {
      confirmed = value;
    },
  });

  await renderInteractive(element, { altScreen: false });
  return confirmed;
}
