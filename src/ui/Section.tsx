import React from 'react';
import { Box, Text } from 'ink';
import { theme, colors } from './theme.js';
import { visibleWidth } from './textWrap.js';

export interface SectionProps {
  title: string;
  subtitle?: string; // e.g., "Pro · ¥50/mo"
  children: React.ReactNode;
  footer?: string; // e.g., "5 models with free tier"
  paddingLeft?: number;
}

/**
 * Section component for grouping related content with a title bar.
 * Used by usage summary (Free Tier, Token Plan, Pay-as-you-go sections).
 *
 * Renders:
 *   ── Title ─────────────────────────────────────────────────────
 *   [children]
 *   ──────────────────────────────────────────────────────────────
 *   footer
 */
export function Section({ title, subtitle, children, footer, paddingLeft = 2 }: SectionProps) {
  // Calculate total width from terminal or use default
  const terminalWidth = process.stdout.columns ?? 80;
  const sectionWidth = terminalWidth - paddingLeft;

  const titlePart = subtitle ? `${title}  ${theme.symbols.dot}  ${subtitle}` : title;
  const titleLen = visibleWidth(titlePart);
  const dashesAfter = Math.max(0, sectionWidth - titleLen);

  return (
    <Box flexDirection="column" paddingLeft={paddingLeft}>
      {/* ── Title bar: Title ──────────────── */}
      <Box>
        {/* Title (+ optional subtitle) in bold brand color */}
        <Text bold color={colors.brand}>
          {titlePart}
        </Text>
        {/* Fill line in border color */}
        <Text color={colors.border}>{'─'.repeat(Math.max(1, dashesAfter))}</Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column">{children}</Box>

      {/* Footer separator */}
      {footer && <Text color={colors.border}>{'─'.repeat(sectionWidth)}</Text>}

      {/* Footer text */}
      {footer && (
        <Box>
          <Text color={colors.muted}>{footer}</Text>
        </Box>
      )}
    </Box>
  );
}
