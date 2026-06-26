import React from 'react';
import { renderInteractive } from '../ui/render.js';
import { TextArea } from '../ui/TextArea.js';
import { releaseOrKeepStdin } from './stdin-control.js';

export interface MultilineInputOptions {
  /** Header shown above the editor frame. */
  title?: string;
  /** Placeholder displayed when the buffer is empty. */
  placeholder?: string;
}

/**
 * Read a multi-line block of text via the Ink TextArea component.
 *
 * Renders in the alternative screen buffer (default) so Ink has a clean
 * canvas — eliminating the frame-stacking artefacts that occurred in
 * inline (non-alt-screen) mode.
 */
export async function multilineInput(options: MultilineInputOptions = {}): Promise<string> {
  let result = '';

  await renderInteractive(
    React.createElement(TextArea, {
      title: options.title ?? 'Enter text',
      placeholder: options.placeholder ?? 'Start typing...',
      onSubmit: (text: string) => {
        result = text;
      },
      onCancel: () => {
        result = '';
      },
    }),
  );

  // Yield one event-loop tick so Ink fully releases stdin before readline takes
  // over; otherwise the next prompt may inherit a paused stream.
  await new Promise((resolve) => setImmediate(resolve));
  releaseOrKeepStdin();

  return result;
}
