/**
 * Unit tests for the <TextArea /> Ink component.
 *
 * Validates:
 *   - Initial rendering (title, placeholder, line numbers)
 *   - Character input and multi-line content display
 *   - Enter creates a new line
 *   - Backspace removes characters / merges lines
 *   - Arrow key navigation
 *   - Tab toggles focus between editor and buttons
 *   - Submit / Cancel buttons and Esc / Ctrl+C cancel shortcuts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

// ── Mock ink: capture useInput callback + provide stub useApp ───────────
let capturedInputHandler:
  | ((input: string, key: Record<string, boolean>) => void)
  | null = null;
const exitMock = vi.fn();

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
      capturedInputHandler = handler;
    },
    useApp: () => ({ exit: exitMock }),
  };
});

const { TextArea } = await import('../../src/ui/TextArea.js');

beforeEach(() => {
  capturedInputHandler = null;
  exitMock.mockReset();
});

function pressKey(input: string, key: Partial<Record<string, boolean>> = {}): void {
  expect(capturedInputHandler).toBeTruthy();
  capturedInputHandler!(input, key as Record<string, boolean>);
}

describe('<TextArea /> rendering', () => {
  it('renders the title when provided', () => {
    const { lastFrame, unmount } = render(
      <TextArea title="Describe your issue" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Describe your issue');
    unmount();
  });

  it('renders the placeholder when editor is empty', () => {
    const { lastFrame, unmount } = render(
      <TextArea placeholder="Type here..." onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Type here...');
    unmount();
  });

  it('renders line numbers starting at 1', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('1');
    unmount();
  });

  it('shows Submit and Cancel buttons', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Submit');
    expect(out).toContain('Cancel');
    unmount();
  });

  it('shows the editor footer hint by default', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Tab Switch focus');
    unmount();
  });
});

describe('<TextArea /> text input', () => {
  it('typing characters updates the rendered content', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('H', {});
    pressKey('i', {});
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Hi');
    unmount();
  });

  it('Enter creates a new line', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('A', {});
    pressKey('', { return: true });
    pressKey('B', {});
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('A');
    expect(out).toContain('B');
    // Two line numbers should exist
    expect(out).toContain('1');
    expect(out).toContain('2');
    unmount();
  });

  it('Backspace removes a character', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('A', {});
    pressKey('B', {});
    pressKey('', { backspace: true });
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('A');
    expect(out).not.toMatch(/AB/);
    unmount();
  });

  it('Backspace at the start of line 2 merges with line 1', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('X', {});
    pressKey('', { return: true });
    pressKey('Y', {});
    // Move cursor to beginning of line 2
    pressKey('', { leftArrow: true });
    // Now backspace should merge lines
    pressKey('', { backspace: true });
    const out = stripAnsi(lastFrame() ?? '');
    // Merged to "XY" with the caret marking the merge point between X and Y.
    expect(out).toContain('X▌Y');
    unmount();
  });
});

describe('<TextArea /> arrow navigation', () => {
  it('left arrow moves the cursor left', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('A', {});
    pressKey('B', {});
    pressKey('', { leftArrow: true });
    // After moving left, the caret sits between A and B.
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('A▌B');
    unmount();
  });

  it('right arrow moves cursor right and wraps to next line', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('A', {});
    pressKey('', { return: true });
    pressKey('B', {});
    // Move to start of line 2
    pressKey('', { leftArrow: true });
    // Move to end of line 1 via up
    pressKey('', { upArrow: true });
    // Move right past end of line 1 should wrap to line 2
    pressKey('', { rightArrow: true });
    pressKey('', { rightArrow: true });
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('A');
    expect(out).toContain('B');
    unmount();
  });

  it('up arrow moves cursor to previous line', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('L', {});
    pressKey('o', {});
    pressKey('n', {});
    pressKey('g', {});
    pressKey('', { return: true });
    pressKey('H', {});
    pressKey('i', {});
    // Move up
    pressKey('', { upArrow: true });
    // Cursor moved up to line 1; caret lands at column 2 (between "Lo" and "ng").
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Lo▌ng');
    expect(out).toContain('Hi');
    unmount();
  });

  it('down arrow moves cursor to next line', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('A', {});
    pressKey('', { return: true });
    pressKey('B', {});
    // Move up then down
    pressKey('', { upArrow: true });
    pressKey('', { downArrow: true });
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('A');
    expect(out).toContain('B');
    unmount();
  });

  it('left arrow at start of line wraps to end of previous line', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('X', {});
    pressKey('', { return: true });
    // Cursor at start of line 2, pressing left wraps to end of line 1
    pressKey('', { leftArrow: true });
    // Now type at end of line 1
    pressKey('Y', {});
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('XY');
    unmount();
  });
});

describe('<TextArea /> focus and buttons', () => {
  it('Tab switches focus to buttons and shows button footer', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('', { tab: true });
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Select');
    expect(out).toContain('Confirm');
    unmount();
  });

  it('left/right arrows switch between Submit and Cancel buttons', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('', { tab: true });
    // Initially Submit is selected (has ▸)
    let out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('▸ Submit');

    pressKey('', { rightArrow: true });
    out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('▸ Cancel');
    unmount();
  });

  it('Enter on Submit button calls onSubmit with text content', () => {
    const onSubmit = vi.fn();
    const { unmount } = render(
      <TextArea onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    pressKey('H', {});
    pressKey('e', {});
    pressKey('l', {});
    pressKey('p', {});
    pressKey('', { tab: true });
    pressKey('', { return: true });
    expect(onSubmit).toHaveBeenCalledWith('Help');
    expect(exitMock).toHaveBeenCalled();
    unmount();
  });

  it('Enter on Cancel button calls onCancel', () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    pressKey('', { tab: true });
    pressKey('', { rightArrow: true });
    pressKey('', { return: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalled();
    unmount();
  });

  it('Tab back to editor restores editor footer', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('', { tab: true });
    pressKey('', { tab: true });
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Tab Switch focus');
    unmount();
  });
});

describe('<TextArea /> cancellation', () => {
  it('Esc triggers onCancel', () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    pressKey('', { escape: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalled();
    unmount();
  });

  it('Ctrl+C triggers onCancel', () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    pressKey('c', { ctrl: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalled();
    unmount();
  });
});

// ── BUG-6: visible cursor caret glyph (stripAnsi-survivable) ───────────────
//
// Contract (per architecture design, aligned with the interactive-session
// caret convention): while the editor holds focus, the caret is rendered as a
// visible insertion glyph `▌` that survives ANSI stripping. ink-testing-library
// strips ALL escape sequences, so an inverse-only cursor would be invisible to
// this harness — the glyph is the implementation-decoupled signal.
//
// Three states must carry the glyph: an empty buffer (placeholder), the end of
// a line, and mid-line (caret sits BEFORE the current column character). A
// non-focused state (buttons focused) is the negative control that guards
// against a collapsed always-on glyph.

const CARET = '▌';

describe('<TextArea /> cursor caret glyph (BUG-6)', () => {
  it('renders a visible caret glyph on the empty placeholder buffer', () => {
    const { lastFrame, unmount } = render(
      <TextArea placeholder="Type here..." onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain(CARET);
    unmount();
  });

  it('renders a visible caret glyph at the end of the typed line', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('H', {});
    pressKey('i', {});
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('Hi');
    expect(out).toContain(CARET);
    unmount();
  });

  it('renders a visible caret glyph when the cursor is mid-line', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('A', {});
    pressKey('B', {});
    pressKey('C', {});
    // Move cursor left twice → caret sits before 'B'.
    pressKey('', { leftArrow: true });
    pressKey('', { leftArrow: true });
    const out = stripAnsi(lastFrame() ?? '');
    // All characters remain readable …
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C');
    // … and the caret glyph is present (caret placed before the current column).
    expect(out).toContain(CARET);
    unmount();
  });

  it('does NOT render the editor caret glyph while focus is on the buttons (negative control)', () => {
    const { lastFrame, unmount } = render(
      <TextArea onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('a', {});
    // Tab moves focus to the buttons; the editor caret must not persist.
    pressKey('', { tab: true });
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('a');
    expect(out).not.toContain(CARET);
    unmount();
  });
});
