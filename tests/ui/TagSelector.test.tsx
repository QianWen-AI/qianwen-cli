/**
 * Unit tests for the <TagSelector /> Ink component.
 *
 * Validates:
 *   - Renders all tag options with checkbox + cursor markers
 *   - ↑/↓ (and j/k) navigation moves focus
 *   - Space toggles selection of the focused tag
 *   - Enter confirms with the picked tags (in original order)
 *   - Esc / Ctrl+C cancels via onCancel
 *   - required=true blocks Enter when no tags are selected
 *   - required=false accepts an empty selection on Enter (returns [])
 *   - Multi-select retains every toggled tag in the result
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

// ── Mock ink: capture useInput callback + provide stub useApp ───────────
let capturedInputHandler: ((input: string, key: Record<string, boolean>) => void) | null = null;
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

const { TagSelector } = await import('../../src/ui/TagSelector.js');

beforeEach(() => {
  capturedInputHandler = null;
  exitMock.mockReset();
});

const SAMPLE_TAGS = [
  'Good Service Attitude',
  'Fast Service Efficiency',
  'Strong Service Professionalism',
];

function pressKey(input: string, key: Partial<Record<string, boolean>> = {}): void {
  expect(capturedInputHandler).toBeTruthy();
  capturedInputHandler!(input, key as Record<string, boolean>);
}

describe('<TagSelector /> rendering', () => {
  it('renders every tag option', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    for (const tag of SAMPLE_TAGS) {
      expect(out).toContain(tag);
    }
    unmount();
  });

  it('renders an unchecked checkbox marker for every tag initially', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    // Each tag line carries a "[ ]" marker before any space toggle.
    const checkboxCount = (out.match(/\[ \]/g) ?? []).length;
    expect(checkboxCount).toBeGreaterThanOrEqual(SAMPLE_TAGS.length);
    expect(out).not.toContain('[x]');
    unmount();
  });

  it('shows the optional/required hint in the footer when required=false', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out.toLowerCase()).toContain('optional');
    unmount();
  });

  it('shows the "at least 1 required" hint when required=true', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={true} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toMatch(/at least 1 required/i);
    unmount();
  });

  it('renders a placeholder when the tag list is empty', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={[]} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const out = stripAnsi(lastFrame() ?? '');
    expect(out.toLowerCase()).toMatch(/no tags/);
    unmount();
  });
});

describe('<TagSelector /> navigation', () => {
  it('moves focus down with ↓ arrow', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('', { downArrow: true });
    const rawFrame = lastFrame() ?? '';
    const lines = rawFrame.split('\n');
    const focusedLine = lines.find((l) => l.includes('▸'));
    expect(focusedLine).toBeTruthy();
    expect(focusedLine).toContain('Fast Service Efficiency');
    unmount();
  });

  it('moves focus down with "j"', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('j', {});
    const focusedLine = (lastFrame() ?? '').split('\n').find((l) => l.includes('▸'));
    expect(focusedLine).toContain('Fast Service Efficiency');
    unmount();
  });

  it('moves focus up with ↑ arrow but never above the first tag', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey('', { upArrow: true });
    pressKey('', { upArrow: true });
    const focusedLine = (lastFrame() ?? '').split('\n').find((l) => l.includes('▸'));
    expect(focusedLine).toContain('Good Service Attitude');
    unmount();
  });

  it('clamps focus at the last tag when pressing ↓ past the bottom', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    for (let i = 0; i < 10; i++) pressKey('', { downArrow: true });
    const focusedLine = (lastFrame() ?? '').split('\n').find((l) => l.includes('▸'));
    expect(focusedLine).toContain('Strong Service Professionalism');
    unmount();
  });
});

describe('<TagSelector /> selection toggling', () => {
  it('Space toggles the focused tag and renders [x]', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey(' ', {});
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('[x]');
    unmount();
  });

  it('Space twice toggles back to unchecked', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey(' ', {});
    pressKey(' ', {});
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).not.toContain('[x]');
    unmount();
  });

  it('updates the "Selected: N" counter as tags are toggled', () => {
    const { lastFrame, unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    pressKey(' ', {}); // select first
    pressKey('', { downArrow: true });
    pressKey(' ', {}); // select second
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toMatch(/Selected:\s*2/);
    unmount();
  });
});

describe('<TagSelector /> confirmation (Enter)', () => {
  it('returns the picked tags in original order on Enter', () => {
    const onSelect = vi.fn();
    const { unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    // Toggle index 2 first, then index 0 — confirm order is preserved by index.
    pressKey('', { downArrow: true });
    pressKey('', { downArrow: true });
    pressKey(' ', {}); // toggle "Strong Service Professionalism"
    pressKey('', { upArrow: true });
    pressKey('', { upArrow: true });
    pressKey(' ', {}); // toggle "Good Service Attitude"
    pressKey('', { return: true });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith([
      'Good Service Attitude',
      'Strong Service Professionalism',
    ]);
    expect(exitMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('returns a single-element array when only one tag is selected', () => {
    const onSelect = vi.fn();
    const { unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    pressKey(' ', {});
    pressKey('', { return: true });

    expect(onSelect).toHaveBeenCalledWith(['Good Service Attitude']);
    unmount();
  });

  it('required=true blocks Enter when no tag is selected', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={true} onSelect={onSelect} onCancel={onCancel} />,
    );
    pressKey('', { return: true });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
    unmount();
  });

  it('required=true accepts Enter once at least one tag is selected', () => {
    const onSelect = vi.fn();
    const { unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={true} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    pressKey(' ', {});
    pressKey('', { return: true });
    expect(onSelect).toHaveBeenCalledWith(['Good Service Attitude']);
    unmount();
  });

  it('required=false accepts Enter with an empty selection (returns [])', () => {
    const onSelect = vi.fn();
    const { unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    pressKey('', { return: true });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith([]);
    expect(exitMock).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('<TagSelector /> cancellation', () => {
  it('Esc triggers onCancel and exits', () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const { unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={onSelect} onCancel={onCancel} />,
    );
    pressKey('', { escape: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('Ctrl+C triggers onCancel and exits', () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={vi.fn()} onCancel={onCancel} />,
    );
    pressKey('c', { ctrl: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('Esc cancels even when tags are already selected (selection is discarded)', () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const { unmount } = render(
      <TagSelector tags={SAMPLE_TAGS} required={false} onSelect={onSelect} onCancel={onCancel} />,
    );
    pressKey(' ', {});
    pressKey('', { escape: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });
});
