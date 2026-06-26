import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Section } from './Section.js';
import { colors } from './theme.js';
import type { CategorySuggestion } from '../types/support.js';

export type SuggestionChoiceKind = 'keep' | 'suggestion';

export interface SuggestionChoice {
  kind: SuggestionChoiceKind;
  categoryId: string;
  categoryPath: string;
}

export interface SuggestionPickerProps {
  userCategoryId: string;
  userCategoryPath: string;
  suggestions: CategorySuggestion[];
  onSelect: (choice: SuggestionChoice) => void;
  onCancel: () => void;
}

export function SuggestionPicker({
  userCategoryId,
  userCategoryPath,
  suggestions,
  onSelect,
  onCancel,
}: SuggestionPickerProps) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);

  type Item = { label: string; choice: SuggestionChoice };
  const items: Item[] = [
    {
      label: `Keep your selection: ${userCategoryPath}`,
      choice: { kind: 'keep', categoryId: userCategoryId, categoryPath: userCategoryPath },
    },
    ...suggestions.map((s) => ({
      label: s.categoryPath || s.categoryName || s.categoryId,
      choice: {
        kind: 'suggestion' as const,
        categoryId: s.categoryId,
        categoryPath: s.categoryPath || s.categoryName || s.categoryId,
      },
    })),
  ];

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
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const item = items[selectedIndex];
      if (!item) return;
      onSelect(item.choice);
      exit();
      return;
    }
  });

  const footer = '\u2191/\u2193 Navigate   Enter Select   Esc/Ctrl+C Cancel';

  return (
    <Section
      title="Suggested categories"
      subtitle="AI proposed alternatives based on your description"
      footer={footer}
    >
      <Box flexDirection="column" paddingLeft={2}>
        {items.map((item, idx) => {
          const selected = idx === selectedIndex;
          return (
            <Box key={`sg-${idx}`}>
              <Text color={selected ? colors.brand : colors.muted}>
                {selected ? '\u25B6 ' : '  '}
              </Text>
              <Text
                color={selected ? colors.headerFg : undefined}
                backgroundColor={selected ? colors.headerBg : undefined}
                bold={selected}
              >
                {item.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Section>
  );
}
