import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

export type StatusLevel = 'pass' | 'warn' | 'info' | 'fail';

export interface StatusLineProps {
  status: StatusLevel;
  label: string;
  detail: string;
  action?: string;
}

const statusConfig: Record<StatusLevel, { symbol: string; color: (s: string) => string }> = {
  pass: { symbol: theme.symbols.pass, color: theme.success },
  fail: { symbol: theme.symbols.fail, color: theme.error },
  warn: { symbol: theme.symbols.warn, color: theme.warning },
  info: { symbol: theme.symbols.info, color: theme.info },
};

const LABEL_WIDTH = 20;

export function StatusLine({ status, label, detail, action }: StatusLineProps) {
  const { symbol, color } = statusConfig[status];
  const paddedLabel = label.padEnd(LABEL_WIDTH);

  return (
    <Box paddingLeft={2}>
      <Text>{color(symbol)}</Text>
      <Text>{'  '}</Text>
      <Text bold>{paddedLabel}</Text>
      <Text>{detail}</Text>
      {action && <Text dimColor>{`  ${action}`}</Text>}
    </Box>
  );
}
