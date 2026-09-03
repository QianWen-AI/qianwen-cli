import React from 'react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RechargeResultFinalViewModel } from '../../src/view-models/billing/recharge.js';

// Stub useApp().exit so ink-testing-library doesn't actually tear down.
// Override useStdin to report isRawModeSupported=true so the component's
// raw-mode + data-listener path is exercised fully.
const { exitSpy } = vi.hoisted(() => ({ exitSpy: vi.fn() }));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useApp: () => ({ exit: exitSpy }),
    useStdin: () => {
      const real = actual.useStdin();
      return { ...real, isRawModeSupported: true };
    },
  };
});

const { RechargePaymentWaitInk } = await import('../../src/ui/RechargePayment.js');

/**
 * Render the wait frame with a usable test stdin.
 *
 * ink-testing-library's test stdin lacks ref/unref/setRawMode that Ink and
 * the component expect.  These are patched synchronously after mount but
 * before passive effects flush, so the component's useEffect sees them.
 */
function renderWait(element: React.ReactElement) {
  const instance = render(element);
  const stdin = instance.stdin as unknown as Record<string, unknown>;
  if (typeof stdin.ref !== 'function') stdin.ref = () => {};
  if (typeof stdin.unref !== 'function') stdin.unref = () => {};
  // Always install a spy so tests can assert raw-mode calls.
  stdin.setRawMode = vi.fn();
  if (typeof stdin.resume !== 'function') stdin.resume = vi.fn();
  return instance;
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const neverSettles = new Promise<RechargeResultFinalViewModel>(() => {});

beforeEach(() => {
  exitSpy.mockReset();
});

describe('RechargePaymentWaitInk', () => {
  it('always renders an empty frame as <></>', () => {
    const instance = renderWait(
      <RechargePaymentWaitInk resultPromise={neverSettles} onCancel={() => {}} interactive />,
    );
    const frame = (instance.lastFrame() ?? '').trim();
    instance.unmount();

    expect(frame).toBe('');
  });

  it('triggers onCancel from a stdin data event carrying Ctrl+C (ETX \\u0003)', async () => {
    const onCancel = vi.fn();
    const instance = renderWait(
      <RechargePaymentWaitInk resultPromise={neverSettles} onCancel={onCancel} interactive />,
    );
    await flushEffects();

    instance.stdin.write('\u0003');
    await flushEffects();
    instance.unmount();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores Ctrl+C in non-interactive mode', async () => {
    const onCancel = vi.fn();
    const instance = renderWait(
      <RechargePaymentWaitInk
        resultPromise={neverSettles}
        onCancel={onCancel}
        interactive={false}
      />,
    );
    await flushEffects();

    instance.stdin.write('\u0003');
    await flushEffects();
    instance.unmount();

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('reports the latest width on resize and removes data/resize listeners on unmount', async () => {
    const onWidthChange = vi.fn();
    const instance = renderWait(
      <RechargePaymentWaitInk
        resultPromise={neverSettles}
        onCancel={() => {}}
        interactive
        onWidthChange={onWidthChange}
      />,
    );
    const stdin = instance.stdin as unknown as NodeJS.EventEmitter;
    const stdout = instance.stdout as unknown as NodeJS.EventEmitter & { columns: number };
    Object.defineProperty(stdout, 'columns', { value: 80, configurable: true });
    const resizeListenersBefore = stdout.listenerCount('resize');
    let dataListenersBeforeUnmount = 0;
    let resizeListenersBeforeUnmount = 0;
    let widthCallsBeforeUnmount = 0;
    try {
      await flushEffects();

      dataListenersBeforeUnmount = stdin.listenerCount('data');
      resizeListenersBeforeUnmount = stdout.listenerCount('resize');
      expect(dataListenersBeforeUnmount).toBeGreaterThan(0);
      expect(resizeListenersBeforeUnmount).toBeGreaterThan(resizeListenersBefore);
      expect(onWidthChange).toHaveBeenCalledWith(80);

      Object.defineProperty(stdout, 'columns', { value: 120, configurable: true });
      stdout.emit('resize');
      expect(onWidthChange).toHaveBeenLastCalledWith(120);
      widthCallsBeforeUnmount = onWidthChange.mock.calls.length;
    } finally {
      instance.unmount();
      await flushEffects();
    }

    expect(stdin.listenerCount('data')).toBeLessThan(dataListenersBeforeUnmount);
    expect(stdout.listenerCount('resize')).toBeLessThan(resizeListenersBeforeUnmount);
    stdout.emit('resize');
    expect(onWidthChange).toHaveBeenCalledTimes(widthCallsBeforeUnmount);
  });

  it('sets raw mode during an interactive mount', async () => {
    const instance = renderWait(
      <RechargePaymentWaitInk resultPromise={neverSettles} onCancel={() => {}} interactive />,
    );
    await flushEffects();

    const stdin = instance.stdin as unknown as { setRawMode: ReturnType<typeof vi.fn> };
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);

    instance.unmount();
  });

  it('exits the renderer after the result promise resolves', async () => {
    const settled = Promise.resolve<RechargeResultFinalViewModel>({
      type: 'recharge',
      rechargeOrderId: 'order-wait-exit',
      status: 'DONE',
    });
    const instance = renderWait(
      <RechargePaymentWaitInk resultPromise={settled} onCancel={() => {}} interactive />,
    );
    await flushEffects();
    instance.unmount();

    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('exits the renderer instead of hanging after the result promise rejects', async () => {
    const rejected = Promise.reject<RechargeResultFinalViewModel>(new Error('network down'));
    void rejected.catch(() => undefined);
    const instance = renderWait(
      <RechargePaymentWaitInk resultPromise={rejected} onCancel={() => {}} interactive />,
    );
    await flushEffects();
    instance.unmount();

    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting while the result remains pending', async () => {
    const instance = renderWait(
      <RechargePaymentWaitInk resultPromise={neverSettles} onCancel={() => {}} interactive />,
    );
    await flushEffects();
    instance.unmount();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
