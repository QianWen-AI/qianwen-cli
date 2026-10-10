import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

interface TestKey {
  ctrl?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

let inputHandler: ((input: string, key: TestKey) => void) | null = null;
const exitMock = vi.fn();

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (
      handler: (input: string, key: TestKey) => void,
      options?: { isActive?: boolean },
    ) => {
      if (options?.isActive !== false) inputHandler = handler;
    },
    useApp: () => ({ exit: exitMock }),
  };
});

import { PurchasePrompt } from '../../src/ui/TokenPlanPurchase.js';
import type { TokenPlanPurchasePreviewViewModel } from '../../src/view-models/subscription/tokenplan-purchase.js';
import type { TokenPlanPurchaseDecision } from '../../src/services/tokenplan-purchase-service.js';

const ORIGINAL_ROWS = process.stdout.rows;
const ORIGINAL_COLUMNS = process.stdout.columns;

function setTerminal(rows: number, columns = 100): void {
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
}

function makeVm(lineCount: number): TokenPlanPurchasePreviewViewModel {
  return {
    title: 'TOKEN PLAN PURCHASE',
    lines: Array.from({ length: lineCount }, (_, index) =>
      index === 0
        ? 'Quote or selection changed. Review and confirm again.'
        : `DETAIL ${String(index + 1).padStart(2, '0')} ${'long-value '.repeat(12)}`,
    ),
    options: [
      { key: '1', label: 'Confirm purchase', decision: { action: 'confirm' } },
      { key: '2', label: 'Change or remove coupon', decision: { action: 'select-coupon' } },
      {
        key: '3',
        label: 'Change balance deduction',
        decision: { action: 'custom-deduction' },
      },
      { key: '0', label: 'Cancel purchase', decision: { action: 'cancel' } },
    ],
    couponOptions: [
      {
        key: '1',
        label:
          'Large coupon (current)\n   Available balance: ¥100.00\n   Valid until: 2026-12-31\n   Current selection',
        decision: { action: 'coupon', coupon: 'coupon-a' },
      },
      {
        key: '2',
        label: 'Short coupon',
        decision: { action: 'coupon', coupon: 'coupon-b' },
      },
      {
        key: '3',
        label:
          'Detailed coupon\n   Available balance: ¥10.00\n   Face value: ¥5.00\n   Valid until: 2027-01-01\n   Extra detail',
        decision: { action: 'coupon', coupon: 'coupon-c' },
      },
      {
        key: '0',
        label: 'Do not use a coupon',
        decision: { action: 'coupon', coupon: 'NO_COUPON' },
      },
    ],
  };
}

function frameLines(frame: string | undefined): string[] {
  return stripAnsi(frame ?? '').split('\n');
}

function invokeInput(input: string, key: TestKey = {}): void {
  if (!inputHandler) throw new Error('Input handler was not registered');
  inputHandler(input, key);
}

function renderPrompt(vm = makeVm(28)) {
  const choose = vi.fn<(decision: TokenPlanPurchaseDecision) => void>();
  const cancel = vi.fn();
  const instance = render(
    <PurchasePrompt vm={vm} maxDeduction="100" choose={choose} cancel={cancel} />,
  );
  return { ...instance, choose, cancel };
}

beforeEach(() => {
  inputHandler = null;
  exitMock.mockReset();
  setTerminal(40);
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'rows', {
    value: ORIGINAL_ROWS,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'columns', {
    value: ORIGINAL_COLUMNS,
    configurable: true,
  });
});

describe('<PurchasePrompt /> terminal viewport', () => {
  it('shows all content without scroll indicators at 40 rows', () => {
    const instance = renderPrompt();
    const frame = stripAnsi(instance.lastFrame() ?? '');

    expect(frame).toContain('DETAIL 28');
    expect(frame).toContain('Select an action');
    expect(frame).not.toMatch(/\[\d+-\d+\/\d+ ↑\/↓\]/);
    expect(frameLines(frame)).toHaveLength(36);
    expect(frameLines(frame).length).toBeLessThan(40);
    instance.unmount();
  });

  it('opens the coupon page on a combined 2\\r input and keeps both pages within 24 rows', () => {
    setTerminal(24);
    const instance = renderPrompt();
    const purchaseFrame = stripAnsi(instance.lastFrame() ?? '');

    expect(frameLines(purchaseFrame).length).toBeLessThanOrEqual(23);
    expect(purchaseFrame).toContain('Select an action');

    invokeInput('2\r');
    const couponFrame = stripAnsi(instance.lastFrame() ?? '');
    expect(couponFrame).toContain('AVAILABLE COUPONS');
    expect(couponFrame).toContain('Large coupon');
    expect(frameLines(couponFrame).length).toBeLessThanOrEqual(23);
    instance.unmount();
  });

  it.each([20, 12])('keeps actions visible while scrolling to the bottom at %i rows', (rows) => {
    setTerminal(rows);
    const instance = renderPrompt();
    const initial = stripAnsi(instance.lastFrame() ?? '');

    expect(initial).toContain('DETAIL 02');
    expect(initial).not.toContain('DETAIL 28');
    expect(frameLines(initial).length).toBeLessThanOrEqual(rows - 1);

    for (let index = 0; index < 40; index += 1) invokeInput('', { downArrow: true });
    const bottom = stripAnsi(instance.lastFrame() ?? '');
    expect(bottom).toContain('DETAIL 28');
    expect(bottom).toContain('Select an action');
    expect(frameLines(bottom).length).toBeLessThanOrEqual(rows - 1);

    invokeInput('', { escape: true });
    expect(instance.choose).toHaveBeenCalledWith({ action: 'cancel' });
    expect(exitMock).toHaveBeenCalled();
    instance.unmount();
  });

  it('keeps the focused coupon visible and selectable in a short terminal', () => {
    setTerminal(12);
    const instance = renderPrompt();
    invokeInput('2\r');

    invokeInput('', { downArrow: true });
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('Short coupon');

    invokeInput('', { downArrow: true });
    const focused = stripAnsi(instance.lastFrame() ?? '');
    expect(focused).toContain('Detailed coupon');
    expect(frameLines(focused).length).toBeLessThanOrEqual(11);

    invokeInput('', { return: true });
    expect(instance.choose).toHaveBeenCalledWith({ action: 'coupon', coupon: 'coupon-c' });
    expect(exitMock).toHaveBeenCalled();
    instance.unmount();
  });

  it('restores the layout after shrinking and expanding without blank frames or stale scroll state', async () => {
    const subscribe = vi.spyOn(process.stdout, 'on');
    const instance = renderPrompt();
    try {
      expect(stripAnsi(instance.lastFrame() ?? '')).toContain('DETAIL 28');
      // Effects and Ink redraws can exceed a fixed delay under full-suite load.
      await vi.waitFor(() =>
        expect(subscribe).toHaveBeenCalledWith('resize', expect.any(Function)),
      );

      setTerminal(20);
      process.stdout.emit('resize');
      await vi.waitFor(() => {
        const lowFrame = stripAnsi(instance.lastFrame() ?? '');
        expect(lowFrame).toContain('TOKEN PLAN PURCHASE');
        expect(lowFrame).toContain('Select an action');
        expect(frameLines(lowFrame).length).toBeLessThanOrEqual(19);
      });

      setTerminal(40);
      process.stdout.emit('resize');
      await vi.waitFor(() => {
        const restored = stripAnsi(instance.lastFrame() ?? '');
        expect(restored).toContain('DETAIL 28');
        expect(restored).not.toMatch(/\[\d+-\d+\/\d+ ↑\/↓\]/);
        expect(frameLines(restored).length).toBeLessThan(40);
      });
    } finally {
      subscribe.mockRestore();
      instance.unmount();
    }
  });

  it('keeps all logical lines within a narrow terminal width', () => {
    setTerminal(20, 40);
    const instance = renderPrompt();
    const lines = frameLines(instance.lastFrame());

    expect(lines.length).toBeLessThanOrEqual(19);
    expect(lines.every((line) => line.length <= 39)).toBe(true);
    instance.unmount();
  });
});

describe('<PurchasePrompt /> explicit action submission', () => {
  it.each(['', '\r', '\n', '\r\n', '   '])(
    'remains in the main menu after empty input %j and repeated Enter presses',
    (input) => {
      const instance = renderPrompt();
      invokeInput(input, { return: input === '' });
      invokeInput('', { return: true });
      invokeInput('', { return: true });

      expect(instance.choose).not.toHaveBeenCalled();
      expect(instance.cancel).not.toHaveBeenCalled();
      expect(exitMock).not.toHaveBeenCalled();
      const frame = stripAnsi(instance.lastFrame() ?? '');
      expect(frame).toContain('Select an action (0 to cancel):');
      expect(frame).not.toContain('Enter cancels purchase');
      instance.unmount();
    },
  );

  it.each(['backspace', 'delete'] as const)(
    'does not cancel on Enter after %s clears all input',
    (key) => {
      const instance = renderPrompt();
      invokeInput('1');
      invokeInput('', { [key]: true });
      invokeInput('', { return: true });
      expect(instance.choose).not.toHaveBeenCalled();
      expect(exitMock).not.toHaveBeenCalled();
      instance.unmount();
    },
  );

  it.each([
    ['1', 'confirm'],
    ['0', 'cancel'],
  ] as const)('requires Enter after input %s before executing %s', (input, action) => {
    const instance = renderPrompt();
    invokeInput('', { return: true });
    invokeInput(input);
    expect(instance.choose).not.toHaveBeenCalled();
    invokeInput('', { return: true });
    expect(instance.choose).toHaveBeenCalledExactlyOnceWith({ action });
    expect(exitMock).toHaveBeenCalledOnce();
    instance.unmount();
  });

  it('waits after clearing an invalid option and pressing Enter, then permits explicit cancellation', () => {
    const instance = renderPrompt();
    invokeInput('9\r');
    invokeInput('', { return: true });
    expect(instance.choose).not.toHaveBeenCalled();
    invokeInput('0\r');
    expect(instance.choose).toHaveBeenCalledExactlyOnceWith({ action: 'cancel' });
    instance.unmount();
  });

  it('waits on empty Enter after returning from the coupon page', () => {
    const instance = renderPrompt();
    invokeInput('2\r');
    invokeInput('', { escape: true });
    invokeInput('', { return: true });
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('Select an action (0 to cancel):');
    expect(instance.choose).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
    instance.unmount();
  });

  it('returns from the balance page on empty Enter and waits at the main menu', () => {
    const instance = renderPrompt();
    invokeInput('3\r');
    invokeInput('', { return: true });
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('Select an action (0 to cancel):');
    invokeInput('', { return: true });
    expect(instance.choose).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
    instance.unmount();
  });

  it('accepts Ctrl+C after ignoring an empty Enter', () => {
    const instance = renderPrompt();
    invokeInput('', { return: true });
    invokeInput('c', { ctrl: true });
    expect(instance.cancel).toHaveBeenCalledOnce();
    expect(instance.choose).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledOnce();
    instance.unmount();
  });
});
