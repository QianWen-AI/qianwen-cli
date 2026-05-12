import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { VERSION } from '../index.js';
import { site } from '../site.js';

export function Logo() {
  const width = 37;
  const top = `╔${'═'.repeat(width)}╗`;
  const bottom = `╚${'═'.repeat(width)}╝`;

  const pad = (text: string) => {
    const padding = Math.max(0, width - text.length);
    const left = Math.floor(padding / 2);
    const right = padding - left;
    return `║${' '.repeat(left)}${text}${' '.repeat(right)}║`;
  };

  const empty = `║${' '.repeat(width)}║`;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{theme.brand(top)}</Text>
      <Text>{theme.brand(empty)}</Text>
      <Text>{theme.brand(pad(`${site.cliDisplayName}  v${VERSION}`))}</Text>
      <Text>{theme.brand(pad('Manage your AI from terminal'))}</Text>
      <Text>{theme.brand(empty)}</Text>
      <Text>{theme.brand(bottom)}</Text>
    </Box>
  );
}
