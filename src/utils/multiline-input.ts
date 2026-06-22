import React from 'react';
import { TextArea } from '../ui/TextArea.js';
import { renderInteractive } from '../ui/render.js';

export interface MultilineInputOptions {
  /** Header shown above the editor frame. */
  title?: string;
  /** Placeholder displayed when the buffer is empty. */
  placeholder?: string;
}

/**
 * Read a multi-line block of text via the Ink TextArea component.
 *
 * Returns the submitted buffer, or '' on cancel / non-TTY / unsupported terminal.
 */
export async function multilineInput(options: MultilineInputOptions = {}): Promise<string> {
  if (!process.stdin.isTTY) return '';

  let result = '';

  const element = React.createElement(TextArea, {
    title: options.title,
    placeholder: options.placeholder,
    onSubmit: (text: string) => {
      result = text;
    },
    onCancel: () => {
      result = '';
    },
  });

  await renderInteractive(element);
  return result;
}
