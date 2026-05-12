import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { Text } from 'ink';
import { renderWithInk } from '../../src/ui/render.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderWithInk', () => {
  it('renders an Ink element to stdout and resolves after paint', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: any) => true) as any);

    await renderWithInk(<Text>hello-world-render</Text>);

    // At minimum, the trailing newline should have been written
    expect(writeSpy).toHaveBeenCalled();
    const allChunks = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    // The wrapper writes a trailing '\n' after waitUntilExit
    expect(allChunks).toContain('\n');
  });

  it('resolves even when element renders empty content', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: any) => true) as any);

    await renderWithInk(<Text>{''}</Text>);
    expect(writeSpy).toHaveBeenCalled();
  });
});
