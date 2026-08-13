import React, { useState } from 'react';
import path from 'node:path';
import { Box, Text, useInput, useApp } from 'ink';
import { Section } from './Section.js';
import { colors } from './theme.js';
import { renderInteractive } from './render.js';
import { formatCmd } from '../utils/runtime-mode.js';
import type { AgentDirEntry } from '../utils/agent-dirs.js';
import { resolveProjectDir } from '../utils/agent-dirs.js';

/** Distinguishes "continue with the default path" (no agent) from an Agent pick. */
export interface AgentDirSelection {
  path: string;
  agent?: AgentDirEntry;
}

export interface AgentDirPromptProps {
  defaultPath: string;
  agents: AgentDirEntry[];
  slug: string;
  onSelect: (selection: AgentDirSelection) => void;
  onCancel: () => void;
}

type Phase = 'choice' | 'agent-list';

export function AgentDirPrompt({
  defaultPath,
  agents,
  slug,
  onSelect,
  onCancel,
}: AgentDirPromptProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('choice');
  const [choiceIndex, setChoiceIndex] = useState(0);
  const [agentIndex, setAgentIndex] = useState(0);

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      onCancel();
      exit();
      return;
    }

    if (phase === 'choice') {
      if (key.escape) {
        onCancel();
        exit();
        return;
      }
      if (key.leftArrow) {
        setChoiceIndex(0);
        return;
      }
      if (key.rightArrow) {
        setChoiceIndex(1);
        return;
      }
      if (key.return) {
        if (choiceIndex === 0) {
          onSelect({ path: defaultPath });
          exit();
        } else {
          setPhase('agent-list');
          setAgentIndex(0);
        }
        return;
      }
      return;
    }

    if (key.escape) {
      setPhase('choice');
      return;
    }
    if (key.upArrow) {
      setAgentIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      const max = Math.max(0, agents.length - 1);
      setAgentIndex((i) => Math.min(max, i + 1));
      return;
    }
    if (key.return) {
      const agent = agents[agentIndex];
      if (!agent) return;
      onSelect({ path: resolveProjectDir(agent), agent });
      exit();
      return;
    }
  });

  if (phase === 'choice') {
    const choices = ['[Continue with current directory]', '[Select target Agent]'];
    const footer = '\u2190 / \u2192 Switch   Enter Confirm   Esc Cancel';
    return (
      <Section
        title={'\u26A0 Current directory might not be recognized as an agent skills directory'}
        footer={footer}
      >
        <Box paddingLeft={2}>
          <Text color={colors.muted}>Installation directory: </Text>
          <Text>{defaultPath}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text>The Skill will be installed directly into the current directory.</Text>
        </Box>
        <Box paddingLeft={2} marginTop={1}>
          <Text>
            {'To use a different existing directory, rerun this command with --dir <path>.'}
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color={colors.muted}>{formatCmd('skills install <skill-name> --dir <path>')}</Text>
        </Box>
        <Box paddingLeft={2} marginTop={1}>
          <Text>
            Or select a target Agent to install the skill into its skills directory in the current
            project.
          </Text>
        </Box>
        <Box paddingLeft={2} marginTop={1}>
          <Text color={choiceIndex === 0 ? colors.brand : colors.muted}>{'\u25C0 '}</Text>
          {choices.map((label, idx) => {
            const selected = idx === choiceIndex;
            return (
              <React.Fragment key={`choice-${idx}`}>
                {idx > 0 && <Text>{'   '}</Text>}
                <Text
                  color={selected ? colors.headerFg : colors.muted}
                  backgroundColor={selected ? colors.headerBg : undefined}
                  bold={selected}
                >
                  {label}
                </Text>
              </React.Fragment>
            );
          })}
          <Text color={choiceIndex === 1 ? colors.brand : colors.muted}>{' \u25B6'}</Text>
        </Box>
      </Section>
    );
  }

  const VIEWPORT_SIZE = 10;
  const nameWidth = agents.reduce((w, a) => Math.max(w, a.displayName.length), 0);
  const footer = '\u2191/\u2193 Navigate   Enter Confirm   Esc Back   Ctrl+C Cancel';

  const total = agents.length;
  const start = Math.max(
    0,
    Math.min(agentIndex - Math.floor(VIEWPORT_SIZE / 2), total - VIEWPORT_SIZE),
  );
  const end = Math.min(total, start + VIEWPORT_SIZE);
  const visible = agents.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;
  const highlighted = agents[agentIndex];

  return (
    <Section title="Select target Agent" footer={footer}>
      {agents.length === 0 ? (
        <Box paddingLeft={2}>
          <Text color={colors.muted}>No agents available.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={2}>
          {hiddenAbove > 0 && (
            <Box>
              <Text color={colors.muted}>{`  \u25B2 ${hiddenAbove} more above`}</Text>
            </Box>
          )}
          {visible.map((agent, visibleIdx) => {
            const realIdx = start + visibleIdx;
            const selected = realIdx === agentIndex;
            return (
              <Box key={agent.name}>
                <Text color={selected ? colors.brand : colors.muted}>
                  {selected ? '\u25B6 ' : '  '}
                </Text>
                <Text
                  color={selected ? colors.headerFg : undefined}
                  backgroundColor={selected ? colors.headerBg : undefined}
                  bold={selected}
                >
                  {agent.displayName}
                </Text>
                <Text>{' '.repeat(nameWidth - agent.displayName.length + 3)}</Text>
                <Text color={colors.muted}>{`./${agent.projectDir}`}</Text>
              </Box>
            );
          })}
          {hiddenBelow > 0 && (
            <Box>
              <Text color={colors.muted}>{`  \u25BC ${hiddenBelow} more below`}</Text>
            </Box>
          )}
          {highlighted && (
            <Box marginTop={1}>
              <Text color={colors.muted}>Install location: </Text>
              <Text>{path.join(resolveProjectDir(highlighted), slug)}</Text>
            </Box>
          )}
        </Box>
      )}
    </Section>
  );
}

export async function promptAgentDir(
  defaultPath: string,
  agents: AgentDirEntry[],
  slug: string,
): Promise<AgentDirSelection | null> {
  let result: AgentDirSelection | null = null;

  const element = React.createElement(AgentDirPrompt, {
    defaultPath,
    agents,
    slug,
    onSelect: (selection: AgentDirSelection) => {
      result = selection;
    },
    onCancel: () => {
      result = null;
    },
  });

  await renderInteractive(element, { altScreen: false });
  return result;
}
