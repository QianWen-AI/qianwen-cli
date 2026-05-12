import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const cols = [
  { key: 'id', header: 'ID' },
  { key: 'val', header: 'Val' },
];

beforeEach(() => {
  capturedInputHandler = null;
  exitMock.mockReset();
});

describe('<InteractiveTable /> rendering branches', () => {
  it('shows loading state when no initialRows', () => {
    const loadPage = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const { lastFrame } = render(
      <InteractiveTable
        columns={cols}
        totalItems={10}
        perPage={5}
        loadPage={loadPage}
      />
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
      />
    );
    expect(lastFrame()).toContain('r1');
    expect(lastFrame()).not.toContain('Loading');
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('renders error state when loadPage rejects', async () => {
    const loadPage = vi.fn().mockRejectedValue(new Error('network down'));
    const { lastFrame } = render(
      <InteractiveTable
        columns={cols}
        totalItems={5}
        perPage={5}
        loadPage={loadPage}
      />
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toMatch(/Error.*network down/);
  });

  it('renders title via Static when title is provided', () => {
    const { lastFrame } = render(
      <InteractiveTable
        columns={cols}
        totalItems={1}
        perPage={5}
        loadPage={vi.fn()}
        initialRows={[{ id: 'r1', val: 'v1' }]}
        title="My Title"
        subtitle="My Sub"
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
        })
    );
    render(
      <InteractiveTable
        columns={cols}
        totalItems={20}
        perPage={5}
        loadPage={loadPage}
      />
    );
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
      />
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
      />
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
      />
    );
    capturedInputHandler!('z', {});
    capturedInputHandler!('x', {});
    expect(exitMock).not.toHaveBeenCalled();
    expect(loadPage).not.toHaveBeenCalled();
  });
});
