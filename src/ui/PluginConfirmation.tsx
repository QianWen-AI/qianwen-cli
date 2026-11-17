import React from 'react';
import { Text } from 'ink';
import { renderWithInk } from './render.js';

export async function renderPluginConfirmation(message: string): Promise<void> {
  await renderWithInk(<Text>{message}</Text>);
}
