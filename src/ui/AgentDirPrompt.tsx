import React, { useState } from 'react';
import path from 'node:path';
import { Box, Text, useInput, useApp } from 'ink';
import { Section } from './Section.js';
import { colors } from './theme.js';
import { renderInteractive } from './render.js';
import { formatCmd } from '../utils/runtime-mode.js';
import type { AgentDirEntry, AgentScope } from '../utils/agent-dirs.js';
import { resolveProjectDir, resolveGlobalDir, recommendScope } from '../utils/agent-dirs.js';

const EM_DASH = '\u2014';

/** Distinguishes "continue with the default path" (no agent) from an Agent pick. */
export interface AgentDirSelection {
  path: string;
  agent?: AgentDirEntry;
  scope?: AgentScope;
}

export interface AgentDirPromptProps {
  defaultPath: string;
  agents: AgentDirEntry[];
  slug: string;
  /** Determines the noun used in the warning banner ('skill' vs 'skill pack'). */
  kind?: 'install' | 'pack-install';
  onSelect: (selection: AgentDirSelection) => void;
  onCancel: () => void;
}

type Phase = 'choice' | 'agent-list';

// Hermes (projectDir === null) has no project-level skills directory, so it is
// only selectable under the global scope.
function isSelectableAgent(agent: AgentDirEntry | undefined, scope: AgentScope): boolean {
  return !!agent && (scope === 'global' || agent.projectDir !== null);
}

export function AgentDirPrompt({
  defaultPath,
  agents,
  slug,
  kind = 'install',
  onSelect,
  onCancel,
}: AgentDirPromptProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('choice');
  const [choiceIndex, setChoiceIndex] = useState(0);
  const [agentIndex, setAgentIndex] = useState(0);
  // The recommendation must reflect where the user actually is, not the install
  // target path the caller passed in — resolveProjectDir below also anchors on
  // process.cwd(), so the two stay consistent.
  const [scope, setScope] = useState<AgentScope>(() => recommendScope(process.cwd()));

  const nextSelectable = (from: number, target: AgentScope): number => {
    for (let i = from + 1; i < agents.length; i++) {
      if (isSelectableAgent(agents[i], target)) return i;
    }
    return from;
  };

  const prevSelectable = (from: number, target: AgentScope): number => {
    for (let i = from - 1; i >= 0; i--) {
      if (isSelectableAgent(agents[i], target)) return i;
    }
    return from;
  };

  const nearestSelectable = (from: number, target: AgentScope): number => {
    for (let i = from; i < agents.length; i++) {
      if (isSelectableAgent(agents[i], target)) return i;
    }
    for (let i = from - 1; i >= 0; i--) {
      if (isSelectableAgent(agents[i], target)) return i;
    }
    return from;
  };

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
          setAgentIndex(nearestSelectable(0, scope));
        }
        return;
      }
      return;
    }

    if (key.escape) {
      setPhase('choice');
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const next = scope === 'project' ? 'global' : 'project';
      setScope(next);
      if (!isSelectableAgent(agents[agentIndex], next)) {
        setAgentIndex(nearestSelectable(agentIndex, next));
      }
      return;
    }
    if (key.upArrow) {
      setAgentIndex((i) => prevSelectable(i, scope));
      return;
    }
    if (key.downArrow) {
      setAgentIndex((i) => nextSelectable(i, scope));
      return;
    }
    if (key.return) {
      const agent = agents[agentIndex];
      if (!agent || !isSelectableAgent(agent, scope)) return;
      const resolved = scope === 'project' ? resolveProjectDir(agent) : resolveGlobalDir(agent);
      onSelect({ path: resolved ?? defaultPath, agent, scope });
      exit();
      return;
    }
  });

  if (phase === 'choice') {
    const choices = ['[Continue with current directory]', '[Select target Agent]'];
    const footer = '\u2190 / \u2192 Switch   Enter Confirm   Esc Cancel';
    return (
      <Section
        title={`\u26A0 Current directory might not be recognized as an agent skills directory`}
        footer={footer}
      >
        <Box paddingLeft={2} marginTop={1}>
          <Text>
            {kind === 'pack-install'
              ? `The skill pack will be installed into the ${defaultPath} directory.`
              : `The skill will be installed at ${defaultPath}`}
          </Text>
        </Box>
        <Box paddingLeft={2} marginTop={1}>
          <Text>
            {'To use a different existing directory, rerun this command with --dir <path>.'}
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color={colors.muted}>
            {kind === 'pack-install'
              ? formatCmd('skills pack-install <pack-name> --dir <path>')
              : formatCmd('skills install <@provider/skill-name> --dir <path>')}
          </Text>
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
  const footer =
    '\u2191/\u2193 Agent   \u2190/\u2192 Scope   Enter Confirm   Esc Back   Ctrl+C Cancel';

  const recommended = recommendScope(process.cwd());
  const mismatch = scope !== recommended;
  const dirOf = (agent: AgentDirEntry): string | null =>
    scope === 'project' ? resolveProjectDir(agent) : resolveGlobalDir(agent);

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
  const highlightedDir = highlighted ? dirOf(highlighted) : null;

  return (
    <Section title="Select target Agent" footer={footer}>
      {agents.length === 0 ? (
        <Box paddingLeft={2}>
          <Text color={colors.muted}>No agents available.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={2}>
          <Box>
            <Text color={colors.muted}>Scope: </Text>
            <Text color={colors.brand}>{'\u25C0 '}</Text>
            <Text color={colors.headerFg} backgroundColor={colors.headerBg} bold>
              {scope === 'project' ? 'Project' : 'Global'}
            </Text>
            <Text color={colors.brand}>{' \u25B6'}</Text>
          </Box>
          {mismatch && (
            <Box>
              <Text color="red">
                {scope === 'global'
                  ? '\u26A0 Project is recommended for the current location. Global is selected.'
                  : '\u26A0 Global is recommended for the current location. Project is selected.'}
              </Text>
            </Box>
          )}
          {hiddenAbove > 0 && (
            <Box>
              <Text color={colors.muted}>{`  \u25B2 ${hiddenAbove} more above`}</Text>
            </Box>
          )}
          {visible.map((agent, visibleIdx) => {
            const realIdx = start + visibleIdx;
            const selected = realIdx === agentIndex;
            const disabled = !isSelectableAgent(agent, scope);
            const dirText =
              scope === 'project' ? (resolveProjectDir(agent) ?? EM_DASH) : resolveGlobalDir(agent);
            return (
              <Box key={agent.name}>
                <Text color={selected ? colors.brand : colors.muted}>
                  {selected ? '\u25B6 ' : '  '}
                </Text>
                <Text
                  color={disabled ? colors.muted : selected ? colors.headerFg : undefined}
                  backgroundColor={selected && !disabled ? colors.headerBg : undefined}
                  bold={selected && !disabled}
                >
                  {agent.displayName}
                </Text>
                <Text>{' '.repeat(nameWidth - agent.displayName.length + 3)}</Text>
                <Text color={colors.muted}>{dirText}</Text>
              </Box>
            );
          })}
          {hiddenBelow > 0 && (
            <Box>
              <Text color={colors.muted}>{`  \u25BC ${hiddenBelow} more below`}</Text>
            </Box>
          )}
          {highlighted && highlightedDir && (
            <Box marginTop={1}>
              <Text color={colors.muted}>Install location: </Text>
              <Text>
                {path.join(highlightedDir, slug.includes('/') ? slug.split('/').pop()! : slug)}
              </Text>
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
  kind: 'install' | 'pack-install' = 'install',
): Promise<AgentDirSelection | null> {
  let result: AgentDirSelection | null = null;

  const element = React.createElement(AgentDirPrompt, {
    defaultPath,
    agents,
    slug,
    kind,
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
