import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { theme } from './theme.js';
import { site } from '../site.js';
import { padEndVisible } from './textWrap.js';

export interface CardProps {
  title: string;
  children: React.ReactNode;
  width?: number;
}

export function Card({ title, children, width = 80 }: CardProps) {
  const safeWidth = Math.max(10, width);
  const innerWidth = safeWidth - 2; // subtract left + right │

  const h = theme.border('─'.repeat(innerWidth));
  const topBorder = theme.border('┌') + h + theme.border('┐');
  const titleContent = padEndVisible(' ' + title, innerWidth);
  const titleLine =
    theme.border('│') +
    chalk.bgHex(theme.tableHeader.bg).hex(theme.tableHeader.fg).bold(titleContent) +
    theme.border('│');
  const bottomBorder = theme.border('└') + h + theme.border('┘');
  const emptyLine = theme.border('│') + ' '.repeat(innerWidth) + theme.border('│');

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{topBorder}</Text>
      <Text>{titleLine}</Text>
      <Box flexDirection="column">{children}</Box>
      <Text>{emptyLine}</Text>
      <Text>{bottomBorder}</Text>
    </Box>
  );
}

// CardLine: a single line inside a card, wrapped with │ ... │
// Supports a `lines` prop for pre-wrapped multi-line content
export interface CardLineProps {
  children?: React.ReactNode;
  width?: number;
  /** Pre-wrapped lines (for long text that needs multiple bordered lines) */
  lines?: string[];
  /** Apply bold styling to lines (only used when `lines` is provided) */
  boldLine?: boolean;
}

export function CardLine({ children, lines, boldLine, width = 80 }: CardLineProps) {
  const innerWidth = Math.max(0, width - 6);
  const borderChar = theme.border('│');

  // If lines are provided, render each as a single <Text> to avoid
  // Yoga flexbox width-measurement drift with CJK fullwidth characters.
  // Constructing the whole line (borders + content) as one string
  // guarantees the terminal renders it at exactly the intended width.
  if (lines && lines.length > 0) {
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => {
          const padded = padEndVisible(line, innerWidth);
          const styled = boldLine ? chalk.bold(padded) : padded;
          return (
            <Text key={i}>{`${borderChar}  ${styled}  ${borderChar}`}</Text>
          );
        })}
      </Box>
    );
  }

  // Otherwise render children as single line
  return (
    <Box>
      <Text>{`${borderChar}  `}</Text>
      <Box width={innerWidth}>{children}</Box>
      <Text>{`  ${borderChar}`}</Text>
    </Box>
  );
}

// Section divider within a card — brand purple title, blank spacer above
export interface SectionProps {
  title: string;
  children: React.ReactNode;
  width?: number;
}

/**
 * Build the three string segments that make up a Section title line:
 *   `│  ` + paddedTitle + `  │`
 *
 * Exported for tests — pure logic separated from JSX so we can assert visible
 * width without a React renderer. The whitespace MUST live inside string
 * literals (not bare JSX text) to preserve correct border alignment.
 */
export function buildSectionTitleParts(
  title: string,
  width: number,
): { left: string; middle: string; right: string } {
  const safeWidth = Math.max(10, width);
  const innerWidth = Math.max(0, safeWidth - 6); // 3 chars each side (│ + 2 spaces)
  return {
    left: theme.border('│') + '  ',
    middle: padEndVisible(title, innerWidth),
    right: '  ' + theme.border('│'),
  };
}

export function Section({ title, children, width = 80 }: SectionProps) {
  const safeWidth = Math.max(10, width);
  const dividerLine =
    theme.border('├') + theme.border('─'.repeat(safeWidth - 2)) + theme.border('┤');
  const { left, middle, right } = buildSectionTitleParts(title, safeWidth);

  // Render title as a single <Text> to avoid Yoga layout drift with CJK chars
  const sectionTitleLine = `${left}${chalk.bold.hex(site.uiTheme.sectionTitle)(middle)}${right}`;

  return (
    <Box flexDirection="column">
      {/* Section divider ├──┤ */}
      <Text>{dividerLine}</Text>
      <Text>{sectionTitleLine}</Text>
      {children}
    </Box>
  );
}
