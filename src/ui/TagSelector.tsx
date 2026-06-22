import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Section } from './Section.js';
import { colors } from './theme.js';

export interface TagSelectorProps {
  /** Tag candidates to choose from. */
  tags: string[];
  /** When true, Enter is rejected until at least one tag is selected. */
  required: boolean;
  /** Called with the selected tags (in original order) when the user confirms. */
  onSelect: (selected: string[]) => void;
  /** Called when the user aborts via Esc or Ctrl+C. */
  onCancel: () => void;
  /** Optional initial highlight index (0-based). Defaults to 0. */
  initialIndex?: number;
  /** Optional title rendered in the section header. */
  title?: string;
  /** Optional subtitle rendered under the title. */
  subtitle?: string;
}

/**
 * Vertical multi-select tag picker. Arrow keys (or j/k) move between tags;
 * Space toggles the focused tag; Enter confirms the selection; Esc or Ctrl+C
 * cancels. When `required` is true, Enter is ignored while no tag is selected.
 */
export function TagSelector({
  tags,
  required,
  onSelect,
  onCancel,
  initialIndex = 0,
  title = 'Select tags',
  subtitle,
}: TagSelectorProps) {
  const { exit } = useApp();
  const safeInitial = tags.length === 0 ? 0 : Math.min(Math.max(0, initialIndex), tags.length - 1);
  const [focusedIndex, setFocusedIndex] = useState(safeInitial);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set<number>());

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      onCancel();
      exit();
      return;
    }
    if (key.escape) {
      onCancel();
      exit();
      return;
    }
    if (tags.length === 0) {
      if (key.return && !required) {
        onSelect([]);
        exit();
      }
      return;
    }
    if (key.upArrow || input === 'k') {
      setFocusedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setFocusedIndex((i) => Math.min(tags.length - 1, i + 1));
      return;
    }
    if (input === ' ') {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(focusedIndex)) {
          next.delete(focusedIndex);
        } else {
          next.add(focusedIndex);
        }
        return next;
      });
      return;
    }
    if (key.return) {
      if (required && selected.size === 0) {
        return;
      }
      const picked = tags.filter((_, idx) => selected.has(idx));
      onSelect(picked);
      exit();
      return;
    }
  });

  const selectedCount = selected.size;
  const blockedByRequired = required && selectedCount === 0;
  const counter = `Selected: ${selectedCount}${required ? ' (at least 1 required)' : ' (optional)'}`;
  const hint = blockedByRequired
    ? '↑/↓ Navigate   Space Toggle   Enter Confirm (select ≥1)   Esc/Ctrl+C Cancel'
    : '↑/↓ Navigate   Space Toggle   Enter Confirm   Esc/Ctrl+C Cancel';
  const footer = `${counter}\n${hint}`;

  return (
    <Section title={title} subtitle={subtitle} footer={footer}>
      <Box flexDirection="column" paddingLeft={2}>
        {tags.length === 0 ? (
          <Text color={colors.muted}>No tags available.</Text>
        ) : (
          tags.map((tag, idx) => {
            const isFocused = idx === focusedIndex;
            const isChecked = selected.has(idx);
            const checkbox = isChecked ? '[x]' : '[ ]';
            const cursor = isFocused ? '▸' : ' ';
            return (
              <Box key={`tag-${idx}-${tag}`}>
                <Text color={isFocused ? colors.brand : colors.muted}>{`${cursor} `}</Text>
                <Text color={isChecked ? colors.brand : colors.muted}>{`${checkbox} `}</Text>
                <Text
                  color={isFocused ? colors.headerFg : undefined}
                  backgroundColor={isFocused ? colors.headerBg : undefined}
                  bold={isFocused}
                >
                  {tag}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Section>
  );
}
