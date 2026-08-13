import React from 'react';
import { Box, Text } from 'ink';
import { theme, colors } from './theme.js';
import { visibleWidth, truncateByDisplayWidth } from './textWrap.js';
import { useTerminalSize } from './useTerminalSize.js';

export interface SectionProps {
  title: string;
  subtitle?: string; // e.g., "Pro · ¥50/mo"
  children: React.ReactNode;
  footer?: string; // e.g., "5 models with free tier"
  paddingLeft?: number;
  /**
   * Cap the section's display width and truncate title/footer to fit.
   * Only interactive full-screen consumers pass this (wrapped lines break
   * Ink's frame erasure there); one-shot static rendering stays untouched.
   */
  maxWidth?: number;
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
export function Section({
  title,
  subtitle,
  children,
  footer,
  paddingLeft = 2,
  maxWidth,
}: SectionProps) {
  const { columns } = useTerminalSize();
  const effectiveColumns = maxWidth != null ? Math.min(columns, maxWidth) : columns;
  const sectionWidth = effectiveColumns - paddingLeft;

  const rawTitle = subtitle ? `${title}  ${theme.symbols.dot}  ${subtitle}` : title;
  // Reserve one column for the mandatory trailing dash so the line never wraps.
  const titlePart =
    maxWidth != null ? truncateByDisplayWidth(rawTitle, Math.max(1, sectionWidth - 1)) : rawTitle;
  const titleLen = visibleWidth(titlePart);
  const dashesAfter = Math.max(0, sectionWidth - titleLen);
  const footerText =
    footer != null && maxWidth != null
      ? truncateByDisplayWidth(footer, Math.max(1, sectionWidth))
      : footer;

  return (
    <Box flexDirection="column" paddingLeft={paddingLeft}>
      {/* Single Text (nested spans) with truncate-end: during a resize Ink
          re-renders the stale strings at the new, narrower layout width before
          React recomputes them — a two-Text row would fold/overflow, spiking
          output height into Ink's clearTerminal (\x1b[3J) path. Steady-state
          this is a no-op (title+dashes are sized to fit by construction). */}
      <Text wrap="truncate-end">
        <Text bold color={colors.brand}>
          {titlePart}
        </Text>
        <Text color={colors.border}>{'─'.repeat(Math.max(1, dashesAfter))}</Text>
      </Text>

      {/* Content */}
      <Box flexDirection="column">{children}</Box>

      {/* Footer separator */}
      {footer && (
        <Text color={colors.border} wrap="truncate-end">
          {'─'.repeat(Math.max(0, sectionWidth))}
        </Text>
      )}

      {/* Footer text */}
      {footer && (
        <Box>
          <Text color={colors.muted} wrap="truncate-end">
            {footerText}
          </Text>
        </Box>
      )}
    </Box>
  );
}
