import React from 'react';
import { Text } from 'ink';
import { theme, progressColor } from './theme.js';

export interface ProgressBarProps {
  percentage: number; // 0-100, what this represents depends on mode
  mode: 'remaining' | 'used' | 'free-only';
  width?: number; // default 20
  label?: string; // e.g., "85% left" or "20%"
  showLabel?: boolean; // default true
  customColor?: (text: string) => string;
}

export function ProgressBar({
  percentage,
  mode,
  width = 20,
  label,
  showLabel = true,
  customColor,
}: ProgressBarProps) {
  // Special case: "Free (Early Access)" mode
  if (mode === 'free-only') {
    return (
      <Text dimColor>
        {'Free (Early Access)'.padEnd(width + 2)}
        {showLabel && label ? `  ${label}` : ''}
      </Text>
    );
  }

  const clamped = Math.max(0, Math.min(100, percentage));
  // After the 'free-only' early return above, mode is narrowed to 'remaining' | 'used'
  const colorFn = customColor ?? progressColor(clamped, mode);

  // For 'remaining' mode: filled = remaining percentage (starts full, empties as used)
  // For 'used' mode: filled = used percentage (starts empty, fills as used)
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = width - filledCount;

  const filledPart = theme.bar.filled.repeat(filledCount);
  const emptyPart = theme.bar.empty.repeat(emptyCount);

  const barText = colorFn(`${filledPart}${emptyPart}`);
  const labelText = showLabel && label ? `  ${label}` : '';

  return (
    <Text>
      {barText}
      {labelText}
    </Text>
  );
}
