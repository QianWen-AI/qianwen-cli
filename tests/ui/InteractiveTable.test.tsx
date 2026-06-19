import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

// ── Mock ink: capture useInput callback + provide stub useApp ───────────────
let capturedInputHandler: ((input: string, key: any) => void) | null = null;
const exitMock = vi.fn();

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (handler: any) => {
      capturedInputHandler = handler;
    },
    useApp: () => ({ exit: exitMock }),
  };
});

import { InteractiveTable } from '../../src/ui/InteractiveTable.js';

function frame(el: React.ReactElement): string {
  const inst = render(el);
  const f = inst.lastFrame() ?? '';
  inst.unmount();
  return f;
}

const cols = [
  { key: 'id', header: 'ID' },
  { key: 'val', header: 'Val' },
];

// ── Terminal height control ──────────────────────────────────
// useTerminalSize() (consumed by InteractiveTable for viewport sizing) reads
// process.stdout.rows. We override it per-test to drive the viewport window
// height (visibleRows ≈ termRows - RESERVED). Restored after each test.
const ORIGINAL_ROWS = process.stdout.rows;
const ORIGINAL_COLUMNS = process.stdout.columns;

function setTermRows(rows: number): void {
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
}

// Build N rows with zero-padded, individually identifiable ids: row-01 .. row-NN.
function makeRows(n: number): Record<string, string>[] {
  return Array.from({ length: n }, (_, i) => {
    const idx = String(i + 1).padStart(2, '0');
    return { id: `row-${idx}`, val: `v${idx}` };
  });
}

// Count trailing fully-blank lines in a rendered frame.
function trailingBlankLineCount(frameStr: string): number {
  const lines = frameStr.split('\n');
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') count++;
    else break;
  }
  return count;
}

beforeEach(() => {
  capturedInputHandler = null;
  exitMock.mockReset();
  // Keep width wide so column wrapping never truncates/obscures the id cells.
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'rows', { value: ORIGINAL_ROWS, configurable: true });
  Object.defineProperty(process.stdout, 'columns', {
    value: ORIGINAL_COLUMNS,
    configurable: true,
  });
});

describe('<InteractiveTable /> rendering branches', () => {
  it('shows loading state when no initialRows', () => {
    const loadPage = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const { lastFrame } = render(
      <InteractiveTable columns={cols} totalItems={10} perPage={5} loadPage={loadPage} />,
    );
    expect(lastFrame()).toContain('Loading');
  });

  it('uses initialRows immediately without loading state', () => {
    const loadPage = vi.fn();
    const { lastFrame } = render(
      <InteractiveTable
        columns={cols}
        totalItems={3}
        perPage={5}
        loadPage={loadPage}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    expect(lastFrame()).toContain('r1');
    expect(lastFrame()).not.toContain('Loading');
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('renders error state when loadPage rejects', async () => {
    const loadPage = vi.fn().mockRejectedValue(new Error('network down'));
    const { lastFrame } = render(
      <InteractiveTable columns={cols} totalItems={5} perPage={5} loadPage={loadPage} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toMatch(/Error.*network down/);
  });

  it('renders title when title is provided', () => {
    const { lastFrame } = render(
      <InteractiveTable
        columns={cols}
        totalItems={1}
        perPage={5}
        loadPage={vi.fn()}
        initialRows={[{ id: 'r1', val: 'v1' }]}
        title="My Title"
        subtitle="My Sub"
      />,
    );
    expect(lastFrame()).toContain('My Title');
  });

  it('renders persistent footer row', () => {
    const { lastFrame } = render(
      <InteractiveTable
        columns={cols}
        totalItems={1}
        perPage={5}
        loadPage={vi.fn()}
        initialRows={[{ id: 'r1', val: 'v1' }]}
        footer={{ id: 'TOTAL', val: '1' }}
      />,
    );
    expect(lastFrame()).toContain('TOTAL');
  });

  it('shows page X/Y info bar with nav hints', () => {
    const { lastFrame } = render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={vi.fn()}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    expect(lastFrame()).toMatch(/Page 1\/4/);
    expect(lastFrame()).toContain('next');
    expect(lastFrame()).toContain('quit');
  });
});

describe('<InteractiveTable /> keyboard interactions (via mocked useInput)', () => {
  it('calls exit() on q', () => {
    render(
      <InteractiveTable
        columns={cols}
        totalItems={5}
        perPage={5}
        loadPage={vi.fn()}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    expect(capturedInputHandler).toBeTruthy();
    capturedInputHandler!('q', {});
    expect(exitMock).toHaveBeenCalledTimes(1);
  });

  it('calls exit() on Escape', () => {
    render(
      <InteractiveTable
        columns={cols}
        totalItems={5}
        perPage={5}
        loadPage={vi.fn()}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    capturedInputHandler!('', { escape: true });
    expect(exitMock).toHaveBeenCalledTimes(1);
  });

  it('calls exit() on Enter', () => {
    render(
      <InteractiveTable
        columns={cols}
        totalItems={5}
        perPage={5}
        loadPage={vi.fn()}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    capturedInputHandler!('', { return: true });
    expect(exitMock).toHaveBeenCalledTimes(1);
  });

  it('navigates next page via "n" when not on last page', async () => {
    const loadPage = vi.fn().mockResolvedValue([{ id: 'p2', val: 'v2' }]);
    render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={loadPage}
        initialRows={[{ id: 'p1', val: 'v1' }]}
      />,
    );
    capturedInputHandler!('n', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(loadPage).toHaveBeenCalledWith(2);
  });

  it('navigates next via rightArrow', async () => {
    const loadPage = vi.fn().mockResolvedValue([{ id: 'p2', val: 'v2' }]);
    render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={loadPage}
        initialRows={[{ id: 'p1', val: 'v1' }]}
      />,
    );
    capturedInputHandler!('', { rightArrow: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(loadPage).toHaveBeenCalledWith(2);
  });

  it('does not advance past totalPages', () => {
    const loadPage = vi.fn();
    render(
      <InteractiveTable
        columns={cols}
        totalItems={3}
        perPage={5}
        loadPage={loadPage}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    capturedInputHandler!('n', {});
    capturedInputHandler!('', { rightArrow: true });
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('navigates previous via "p" when page > 1', async () => {
    const loadPage = vi.fn().mockResolvedValue([{ id: 'r1', val: 'v1' }]);
    render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={loadPage}
        initialPage={3}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    loadPage.mockClear();
    capturedInputHandler!('p', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(loadPage).toHaveBeenCalledWith(2);
  });

  it('navigates previous via leftArrow', async () => {
    const loadPage = vi.fn().mockResolvedValue([{ id: 'x', val: 'y' }]);
    render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={loadPage}
        initialPage={2}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    loadPage.mockClear();
    capturedInputHandler!('', { leftArrow: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(loadPage).toHaveBeenCalledWith(1);
  });

  it('does not navigate previous when on page 1', () => {
    const loadPage = vi.fn();
    render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={loadPage}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    loadPage.mockClear();
    capturedInputHandler!('p', {});
    capturedInputHandler!('', { leftArrow: true });
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('ignores keys while loading', async () => {
    let resolver: (v: any) => void = () => {};
    const loadPage = vi.fn(
      () =>
        new Promise<any>((r) => {
          resolver = r;
        }),
    );
    render(<InteractiveTable columns={cols} totalItems={20} perPage={5} loadPage={loadPage} />);
    // Wait for the initial useEffect to fire loadPage(1)
    await new Promise((r) => setTimeout(r, 20));
    expect(loadPage).toHaveBeenCalledTimes(1);
    // Now press 'n' while still loading (resolver hasn't been called)
    capturedInputHandler!('n', {});
    await new Promise((r) => setTimeout(r, 20));
    // Still 1 call - 'n' was ignored because loading=true
    expect(loadPage).toHaveBeenCalledTimes(1);
    // Cleanup
    resolver([{ id: 'x', val: 'y' }]);
  });

  it('caches pages: revisiting does not re-call loadPage', async () => {
    const loadPage = vi.fn().mockResolvedValue([{ id: 'r2', val: 'v2' }]);
    render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={loadPage}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    capturedInputHandler!('n', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(loadPage).toHaveBeenCalledTimes(1);

    capturedInputHandler!('p', {});
    await new Promise((r) => setTimeout(r, 20));
    // page 1 was cached from initialRows → no new call
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it('clamps initialPage > totalPages down to totalPages', async () => {
    const loadPage = vi.fn().mockResolvedValue([{ id: 'last', val: '99' }]);
    const { lastFrame } = render(
      <InteractiveTable
        columns={cols}
        totalItems={5}
        perPage={5}
        loadPage={loadPage}
        initialPage={99}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toMatch(/Page 1\/1/);
  });

  it('ignores other unrecognized keys (no exit, no nav)', () => {
    const loadPage = vi.fn();
    render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={loadPage}
        initialRows={[{ id: 'r1', val: 'v1' }]}
      />,
    );
    capturedInputHandler!('z', {});
    capturedInputHandler!('x', {});
    expect(exitMock).not.toHaveBeenCalled();
    expect(loadPage).not.toHaveBeenCalled();
  });
});

describe('<InteractiveTable /> viewport windowing (row-level scroll)', () => {
  // ── Viewport slice (二.4 core) ─────────────────────────────────
  // termRows small (12) + single page with 40 rows. The visible window
  // (≈ termRows - RESERVED) is far smaller than 40, so only the head rows are
  // rendered and the tail row (row-40) must NOT appear in the frame.
  // Pre-fix the component renders ALL page rows → the not.toContain(row-40)
  // assertion is RED.
  it('renders only the viewport window, not the entire page', () => {
    setTermRows(12);
    const out = frame(
      <InteractiveTable
        columns={cols}
        totalItems={40}
        perPage={40}
        loadPage={vi.fn()}
        initialRows={makeRows(40)}
      />,
    );
    // Head of the page is inside the window.
    expect(out).toContain('row-01');
    // Tail row is far beyond the window (40 rows, ~12-row terminal) → must be sliced out.
    expect(out).not.toContain('row-40');
  });

  // ── Scroll down (二.4 core) ────────────────────────────────────
  // Triggering ↓ (down arrow) repeatedly advances the window so a previously
  // hidden row (row-20) becomes visible while the original first row (row-01)
  // scrolls out. Pre-fix there is no scroll handler → frame never changes →
  // the "row-20 now visible" / "row-01 gone" assertions are RED.
  it('scrolls the window down on ↓ revealing later rows', () => {
    setTermRows(12);
    const { lastFrame, unmount } = render(
      <InteractiveTable
        columns={cols}
        totalItems={40}
        perPage={40}
        loadPage={vi.fn()}
        initialRows={makeRows(40)}
      />,
    );
    // Initially row-20 is below the window.
    expect(lastFrame() ?? '').not.toContain('row-20');

    // Scroll down enough rows for row-20 to enter the viewport.
    for (let i = 0; i < 19; i++) {
      capturedInputHandler!('', { downArrow: true });
    }

    const after = lastFrame() ?? '';
    expect(after).toContain('row-20');
    // The original top row has scrolled out of the window.
    expect(after).not.toContain('row-01');
    unmount();
  });

  it('scrolls the window down on "j" (vim key)', () => {
    setTermRows(12);
    const { lastFrame, unmount } = render(
      <InteractiveTable
        columns={cols}
        totalItems={40}
        perPage={40}
        loadPage={vi.fn()}
        initialRows={makeRows(40)}
      />,
    );
    expect(lastFrame() ?? '').not.toContain('row-15');
    for (let i = 0; i < 14; i++) {
      capturedInputHandler!('j', {});
    }
    expect(lastFrame() ?? '').toContain('row-15');
    unmount();
  });

  // ── Scroll up rolls back ─────────────────────────────────────
  it('scrolls back up on ↑ returning to earlier rows', () => {
    setTermRows(12);
    const { lastFrame, unmount } = render(
      <InteractiveTable
        columns={cols}
        totalItems={40}
        perPage={40}
        loadPage={vi.fn()}
        initialRows={makeRows(40)}
      />,
    );
    // Scroll down so the top is no longer visible.
    for (let i = 0; i < 19; i++) {
      capturedInputHandler!('', { downArrow: true });
    }
    expect(lastFrame() ?? '').not.toContain('row-01');

    // Scroll all the way back up.
    for (let i = 0; i < 19; i++) {
      capturedInputHandler!('', { upArrow: true });
    }
    const back = lastFrame() ?? '';
    expect(back).toContain('row-01');
    expect(back).not.toContain('row-20');
    unmount();
  });

  it('scrolls back up on "k" (vim key)', () => {
    setTermRows(12);
    const { lastFrame, unmount } = render(
      <InteractiveTable
        columns={cols}
        totalItems={40}
        perPage={40}
        loadPage={vi.fn()}
        initialRows={makeRows(40)}
      />,
    );
    for (let i = 0; i < 14; i++) {
      capturedInputHandler!('j', {});
    }
    expect(lastFrame() ?? '').not.toContain('row-01');
    for (let i = 0; i < 14; i++) {
      capturedInputHandler!('k', {});
    }
    expect(lastFrame() ?? '').toContain('row-01');
    unmount();
  });

  // ── Page navigation resets scroll offset ──────────────────────────
  // After scrolling within a page, navigating to the next page must reset the
  // scroll offset to 0 so the new page renders from its first row.
  it('resets scroll offset to 0 after navigating to next page', async () => {
    setTermRows(12);
    // Page 1 = rows 1..40, page 2 = rows 41..80 (distinct ids).
    const page2 = Array.from({ length: 40 }, (_, i) => {
      const idx = String(i + 41).padStart(2, '0');
      return { id: `row-${idx}`, val: `v${idx}` };
    });
    const loadPage = vi.fn().mockResolvedValue(page2);
    const { lastFrame, unmount } = render(
      <InteractiveTable
        columns={cols}
        totalItems={80}
        perPage={40}
        loadPage={loadPage}
        initialRows={makeRows(40)}
      />,
    );
    // Scroll down inside page 1 first.
    for (let i = 0; i < 19; i++) {
      capturedInputHandler!('', { downArrow: true });
    }
    expect(lastFrame() ?? '').not.toContain('row-01');

    // Navigate to page 2.
    capturedInputHandler!('', { rightArrow: true });
    await new Promise((r) => setTimeout(r, 20));

    const p2 = lastFrame() ?? '';
    // New page renders from its first row (offset reset to 0).
    expect(p2).toContain('row-41');
    // The deep tail of page 2 stays below the window (proves we are at top, not bottom).
    expect(p2).not.toContain('row-80');
    unmount();
  });

  // ── Boundary: cannot scroll past the end / before the start ───────────────
  it('clamps scroll at the bottom: over-scrolling down stays stable at the end', () => {
    setTermRows(12);
    const { lastFrame, unmount } = render(
      <InteractiveTable
        columns={cols}
        totalItems={40}
        perPage={40}
        loadPage={vi.fn()}
        initialRows={makeRows(40)}
      />,
    );
    // Scroll far beyond maxOffset.
    for (let i = 0; i < 200; i++) {
      capturedInputHandler!('', { downArrow: true });
    }
    const atBottom = lastFrame() ?? '';
    // The last row is now visible and stable.
    expect(atBottom).toContain('row-40');
    // One more down must NOT advance past the end (row-40 still present, window unchanged).
    capturedInputHandler!('', { downArrow: true });
    const after = lastFrame() ?? '';
    expect(after).toContain('row-40');
    expect(after).toBe(atBottom);
    unmount();
  });

  it('clamps scroll at the top: over-scrolling up stays at the first row', () => {
    setTermRows(12);
    const { lastFrame, unmount } = render(
      <InteractiveTable
        columns={cols}
        totalItems={40}
        perPage={40}
        loadPage={vi.fn()}
        initialRows={makeRows(40)}
      />,
    );
    const initial = lastFrame() ?? '';
    expect(initial).toContain('row-01');
    // Attempt to scroll up while already at the top.
    for (let i = 0; i < 5; i++) {
      capturedInputHandler!('', { upArrow: true });
    }
    const after = lastFrame() ?? '';
    expect(after).toContain('row-01');
    // Offset never went negative — frame is unchanged from the initial top view.
    expect(after).toBe(initial);
    unmount();
  });

  // ── Loading guard: scrolling ignored while loading ────────────────────
  it('ignores scroll keys while loading', async () => {
    setTermRows(12);
    const loadPage = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const { lastFrame, unmount } = render(
      <InteractiveTable columns={cols} totalItems={40} perPage={40} loadPage={loadPage} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    const loadingFrame = lastFrame() ?? '';
    expect(loadingFrame).toContain('Loading');
    // Scroll keys during loading must not throw and must not change the loading screen.
    for (let i = 0; i < 10; i++) {
      capturedInputHandler!('', { downArrow: true });
    }
    expect(lastFrame() ?? '').toBe(loadingFrame);
    unmount();
  });
});

describe('<InteractiveTable /> natural height (no padding inflation)', () => {
  // ── No padding (二.1 core) ────────────────────────────────────
  // termRows large (40), content tiny (3 rows). The pre-fix component pads the
  // output with ~ (termRows - contentLines) trailing blank lines to force Ink's
  // clearTerminal full-screen path — which causes the exit blank-screen defect.
  // After removing padLines the frame must render at natural height: the number
  // of trailing blank lines must be far smaller than termRows, and the total
  // frame line count must be close to the content height, not inflated to ~40.
  it('does not pad the frame with trailing blank lines up to terminal height', () => {
    setTermRows(40);
    const out = frame(
      <InteractiveTable
        columns={cols}
        totalItems={3}
        perPage={5}
        loadPage={vi.fn()}
        initialRows={makeRows(3)}
      />,
    );
    const totalLines = out.split('\n').length;
    const trailingBlanks = trailingBlankLineCount(out);

    // Sanity: content is actually rendered.
    expect(out).toContain('row-01');
    expect(out).toContain('row-03');

    // No bulk trailing blank-line inflation toward termRows (40).
    // Pre-fix padding produces ~30+ trailing blank lines → RED here.
    expect(trailingBlanks).toBeLessThan(8);
    // Natural total height stays well below the terminal height.
    // Pre-fix the frame is inflated to ≈ termRows (40) → RED here.
    expect(totalLines).toBeLessThan(20);
  });
});
