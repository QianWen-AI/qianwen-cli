import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Section } from './Section.js';
import { colors } from './theme.js';
import type { CategoryNode } from '../types/support.js';

export interface CategorySelection {
  id: string;
  name: string;
  path: string;
  helpUrl?: string;
}

export interface CategorySelectorProps {
  tree: CategoryNode[];
  onSelect: (selection: CategorySelection) => void;
  onCancel: () => void;
}

export function CategorySelector({ tree, onSelect, onCancel }: CategorySelectorProps) {
  const { exit } = useApp();
  const [breadcrumb, setBreadcrumb] = useState<CategoryNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const currentChildren =
    breadcrumb.length === 0 ? tree : (breadcrumb[breadcrumb.length - 1].children ?? []);

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      onCancel();
      exit();
      return;
    }

    if (key.escape) {
      if (breadcrumb.length === 0) {
        onCancel();
        exit();
      } else {
        setBreadcrumb((b) => b.slice(0, -1));
        setSelectedIndex(0);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (breadcrumb.length > 0) {
        setBreadcrumb((b) => b.slice(0, -1));
        setSelectedIndex(0);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      const max = Math.max(0, currentChildren.length - 1);
      setSelectedIndex((i) => Math.min(max, i + 1));
      return;
    }

    if (key.return) {
      const node = currentChildren[selectedIndex];
      if (!node) return;
      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      if (hasChildren) {
        setBreadcrumb((b) => [...b, node]);
        setSelectedIndex(0);
      } else {
        const path = [...breadcrumb, node].map((n) => n.name).join(' > ');
        onSelect({ id: node.id, name: node.name, path, helpUrl: node.helpUrl });
        exit();
      }
      return;
    }
  });

  const breadcrumbText = breadcrumb.length > 0 ? breadcrumb.map((n) => n.name).join(' > ') : '/';

  const footer = '\u2191/\u2193 Navigate   Enter Select   Esc/Backspace Back   Ctrl+C Cancel';

  return (
    <Section title="Select a category" subtitle={breadcrumbText} footer={footer}>
      {currentChildren.length === 0 ? (
        <Box paddingLeft={2}>
          <Text color={colors.muted}>No categories available at this level.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={2}>
          {currentChildren.map((node, idx) => {
            const selected = idx === selectedIndex;
            const hasChildren = Array.isArray(node.children) && node.children.length > 0;
            const indicator = hasChildren ? ' \u203A' : '';
            return (
              <Box key={node.id || `cat-${idx}`}>
                <Text color={selected ? colors.brand : colors.muted}>
                  {selected ? '\u25B6 ' : '  '}
                </Text>
                <Text
                  color={selected ? colors.headerFg : undefined}
                  backgroundColor={selected ? colors.headerBg : undefined}
                  bold={selected}
                >
                  {node.name}
                  {indicator}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Section>
  );
}
