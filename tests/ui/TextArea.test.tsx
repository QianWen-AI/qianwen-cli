import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

// Mock ink's useInput to capture the keypress handler and useApp.exit.
let capturedHandler: ((input: string, key: Record<string, boolean>) => void) | null = null;
const exitMock = vi.fn();

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
      capturedHandler = handler;
    },
    useApp: () => ({ exit: exitMock }),
  };
});

import { TextArea } from '../../src/ui/TextArea.js';

beforeEach(() => {
  capturedHandler = null;
  exitMock.mockReset();
});

const send = (input: string, key: Partial<Record<string, boolean>> = {}) => {
  if (!capturedHandler) throw new Error('useInput handler not captured yet');
  capturedHandler(input, key as Record<string, boolean>);
};

describe('<TextArea /> rendering', () => {
  it('renders title, placeholder, footer hints, and Submit/Cancel buttons', () => {
    const { lastFrame, unmount } = render(
      <TextArea
        title="Compose"
        placeholder="Type something..."
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Compose');
    expect(out).toContain('Type something...');
    expect(out).toContain('Move');
    expect(out).toContain('New line');
    expect(out).toContain('Submit');
    expect(out).toContain('Cancel');
    unmount();
  });

  it('omits the title block when no title is provided', () => {
    const { lastFrame, unmount } = render(<TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Submit');
    expect(out).toContain('Cancel');
    unmount();
  });

  it('typed input replaces the placeholder with the entered text', () => {
    const { lastFrame, rerender, unmount } = render(
      <TextArea placeholder="Type something..." onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    send('h');
    send('i');
    rerender(<TextArea placeholder="Type something..." onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).not.toContain('Type something...');
    expect(out).toContain('hi');
    unmount();
  });
});

describe('<TextArea /> keyboard handling', () => {
  it('Escape calls onCancel and exits', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(<TextArea onSubmit={onSubmit} onCancel={onCancel} />);
    send('', { escape: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalled();
  });

  it('Ctrl+C cancels (intercepted via "c" + ctrl)', () => {
    const onCancel = vi.fn();
    render(<TextArea onSubmit={vi.fn()} onCancel={onCancel} />);
    send('c', { ctrl: true });
    expect(onCancel).toHaveBeenCalled();
  });

  it('\\x03 (raw Ctrl+C byte) cancels', () => {
    const onCancel = vi.fn();
    render(<TextArea onSubmit={vi.fn()} onCancel={onCancel} />);
    send('\x03');
    expect(onCancel).toHaveBeenCalled();
  });

  it('Tab + Enter submits joined lines via onSubmit', () => {
    const onSubmit = vi.fn();
    render(<TextArea onSubmit={onSubmit} onCancel={vi.fn()} />);
    send('h');
    send('i');
    send('', { tab: true }); // focus → buttons (Submit selected by default)
    send('', { return: true });
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });

  it('Tab + Right + Enter activates Cancel button', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<TextArea onSubmit={onSubmit} onCancel={onCancel} />);
    send('', { tab: true });
    send('', { rightArrow: true });
    send('', { return: true });
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter in editor inserts a newline (split text into 2 lines)', () => {
    const onSubmit = vi.fn();
    render(<TextArea onSubmit={onSubmit} onCancel={vi.fn()} />);
    send('a');
    send('b');
    send('', { return: true });
    send('c');
    send('', { tab: true });
    send('', { return: true });
    expect(onSubmit).toHaveBeenCalledWith('ab\nc');
  });

  it('Backspace deletes the last typed character', () => {
    const onSubmit = vi.fn();
    render(<TextArea onSubmit={onSubmit} onCancel={vi.fn()} />);
    send('h');
    send('i');
    send('', { backspace: true });
    send('', { tab: true });
    send('', { return: true });
    expect(onSubmit).toHaveBeenCalledWith('h');
  });

  it('Tab on buttons returns focus to the editor', () => {
    const onSubmit = vi.fn();
    render(<TextArea onSubmit={onSubmit} onCancel={vi.fn()} />);
    send('', { tab: true }); // → buttons
    send('', { tab: true }); // → editor
    // Now typing should append to the editor, not trigger button selection
    send('z');
    send('', { tab: true });
    send('', { return: true });
    expect(onSubmit).toHaveBeenCalledWith('z');
  });
});
