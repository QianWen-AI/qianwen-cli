import React from 'react';
import { Box, Text } from 'ink';
import { renderWithInk } from './render.js';
import type { ForumSubscribeViewModel } from '../view-models/yunqi/index.js';

export interface YunqiSubscribeResultInkProps {
  vm: ForumSubscribeViewModel;
}

export function YunqiSubscribeResultInk({ vm }: YunqiSubscribeResultInkProps) {
  return (
    <Box>
      <Text color={vm.success ? 'green' : 'red'}>{vm.message}</Text>
    </Box>
  );
}

export async function renderYunqiSubscribeResultInk(vm: ForumSubscribeViewModel): Promise<void> {
  await renderWithInk(<YunqiSubscribeResultInk vm={vm} />);
}
