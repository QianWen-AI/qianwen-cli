import React, { type ReactElement } from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { RechargeCreateOutput, RechargeResultOutput } from '../../../src/types/recharge.js';
import type { RechargePaymentViewModel } from '../../../src/view-models/billing/recharge.js';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';

interface RechargeCreateOptions {
  channel: 'alipay';
  amount: string;
}

interface RechargeResultOptions {
  rechargeOrderId: string;
  signal: AbortSignal;
}

interface InkRenderOptions {
  waitUntil?: Promise<unknown>;
}

interface InteractiveRenderOptions {
  altScreen?: boolean;
  trailingNewline?: boolean;
  protectStaticContent?: boolean;
}

type CreateRecharge = (options: RechargeCreateOptions) => Promise<RechargeCreateOutput>;
type WaitForRechargeResult = (options: RechargeResultOptions) => Promise<RechargeResultOutput>;

type WriteRechargePaymentBlock = (
  vm: RechargePaymentViewModel,
  columns: number,
  canAppendOnResize?: boolean,
) => { readonly qrDrawn: boolean; readonly qrAppendable: boolean };
type AppendRechargeQrBlock = (
  paymentUrl: string,
  columns: number,
) => 'appended' | 'width_insufficient' | 'unavailable';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { ensureAuthenticatedSpy, openBrowserSpy, renderInteractiveSpy, renderWithInkSpy } =
  vi.hoisted(() => ({
    ensureAuthenticatedSpy: vi.fn(() => ({})),
    openBrowserSpy: vi.fn<(url: string) => Promise<boolean>>(),
    renderInteractiveSpy:
      vi.fn<(element: ReactElement, options?: InteractiveRenderOptions) => Promise<void>>(),
    renderWithInkSpy:
      vi.fn<
        (
          element: ReactElement<Record<string, unknown>>,
          options?: InkRenderOptions,
        ) => Promise<void>
      >(),
  }));

// Partial mock of the payment-block writer. writeRechargePaymentBlock defaults
// to the real implementation (restored in beforeEach) so the flow tests still
// exercise real static output.
const { appendRechargeQrBlockSpy, writeRechargePaymentBlockSpy, blockActual } = vi.hoisted(() => ({
  appendRechargeQrBlockSpy: vi.fn<AppendRechargeQrBlock>(),
  writeRechargePaymentBlockSpy: vi.fn<WriteRechargePaymentBlock>(),
  blockActual: {} as {
    appendRechargeQrBlock?: AppendRechargeQrBlock;
    writeRechargePaymentBlock?: WriteRechargePaymentBlock;
  },
}));

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: ensureAuthenticatedSpy,
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => undefined,
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
  renderWithInkSync: renderWithInkSpy,
  renderInteractive: renderInteractiveSpy,
}));
vi.mock('../../../src/utils/open-browser.js', () => ({
  openBrowser: openBrowserSpy,
}));
vi.mock('../../../src/output/recharge-payment-block.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/output/recharge-payment-block.js')>();
  blockActual.appendRechargeQrBlock = actual.appendRechargeQrBlock;
  blockActual.writeRechargePaymentBlock = actual.writeRechargePaymentBlock;
  return {
    ...actual,
    appendRechargeQrBlock: appendRechargeQrBlockSpy,
    writeRechargePaymentBlock: writeRechargePaymentBlockSpy,
  };
});

const { registerBillingBalanceRechargeCommand } =
  await import('../../../src/commands/billing/balance/recharge.js');

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const restores: (() => void)[] = [];

function setStdinTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

function restoreStdinTTY(): void {
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
}

function override<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

function setQrCapableTerminal(columns: number, qrStyle: 'compact' | 'full' = 'compact'): void {
  override(process.stdout, 'columns', columns);
  override(process.stdout, 'isTTY', true);
  override(
    process.stdout,
    'hasColors',
    vi.fn(() => true) as unknown as typeof process.stdout.hasColors,
  );
  const chalkLevel = chalk.level;
  chalk.level = 3;
  restores.push(() => {
    chalk.level = chalkLevel;
  });
  const previousQrStyle = process.env.QIANWEN_QR_STYLE;
  process.env.QIANWEN_QR_STYLE = qrStyle;
  restores.push(() => {
    if (previousQrStyle === undefined) Reflect.deleteProperty(process.env, 'QIANWEN_QR_STYLE');
    else process.env.QIANWEN_QR_STYLE = previousQrStyle;
  });
}

function buildRecharge(program: import('commander').Command): void {
  const billing = program.command('billing');
  const balance = billing.command('balance');
  registerBillingBalanceRechargeCommand(balance);
}

const createdOrder: RechargeCreateOutput = {
  type: 'recharge',
  channel: 'alipay',
  amount: '1.00',
  currency: 'CNY',
  status: 'pending',
  rechargeOrderId: 'order_command_test_1',
  paymentUrl: 'https://pay.test.qianwenai.com/recharge?order=order_command_test_1',
};

const completedOrder: RechargeResultOutput = {
  type: 'recharge',
  rechargeOrderId: createdOrder.rechargeOrderId,
  RechargeStatus: 'DONE',
};

beforeEach(() => {
  holder.services = makeMockServices();
  ensureAuthenticatedSpy.mockClear();
  openBrowserSpy.mockReset();
  openBrowserSpy.mockResolvedValue(false);
  renderInteractiveSpy.mockReset();
  renderInteractiveSpy.mockResolvedValue(undefined);
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(async (_element, options) => {
    await options?.waitUntil;
  });
  // Restore the payment-block spy to its real implementation so flow tests keep
  // asserting real static output.
  appendRechargeQrBlockSpy.mockReset();
  if (blockActual.appendRechargeQrBlock) {
    appendRechargeQrBlockSpy.mockImplementation(blockActual.appendRechargeQrBlock);
  }
  writeRechargePaymentBlockSpy.mockReset();
  if (blockActual.writeRechargePaymentBlock) {
    writeRechargePaymentBlockSpy.mockImplementation(blockActual.writeRechargePaymentBlock);
  }
  setStdinTTY(false);
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  restoreStdinTTY();
});

describe('billing balance recharge argument contract', () => {
  it('reports a missing channel value when the next token is --amount', async () => {
    const result = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--channel',
      '--amount',
      '0.01',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      "error: option '--channel <channel>' argument missing. Available values: alipay",
    );
    expect(ensureAuthenticatedSpy).not.toHaveBeenCalled();
    expect(openBrowserSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['only --channel', ['--channel', 'alipay']],
    ['only --amount', ['--amount', '1.00']],
    ['unsupported channel', ['--channel', 'wechat', '--amount', '1.00']],
    ['zero amount', ['--channel', 'alipay', '--amount', '0']],
    ['negative amount', ['--channel', 'alipay', '--amount', '-1']],
    ['amount with too many decimals', ['--channel', 'alipay', '--amount', '1.001']],
  ])('%s fails before authentication without opening a browser', async (_name, options) => {
    const createRecharge = vi.fn<CreateRecharge>();
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>();
    holder.services = makeMockServices({
      billingService: { createRecharge, waitForRechargeResult },
    });

    const result = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      ...options,
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('INVALID_ARGUMENT');
    expect(ensureAuthenticatedSpy).not.toHaveBeenCalled();
    expect(createRecharge).not.toHaveBeenCalled();
    expect(waitForRechargeResult).not.toHaveBeenCalled();
    expect(openBrowserSpy).not.toHaveBeenCalled();
  });
});

describe('billing balance recharge non-interactive order creation', () => {
  it.each(['json', 'text'] as const)(
    '%s creates exactly one order and returns without waiting',
    async (format) => {
      const createRecharge = vi.fn<CreateRecharge>(async ({ amount }) => ({
        ...createdOrder,
        amount,
      }));
      const waitForRechargeResult = vi.fn<WaitForRechargeResult>();
      const getAvailableBalance = vi.fn();
      holder.services = makeMockServices({
        billingService: { createRecharge, waitForRechargeResult, getAvailableBalance },
      });

      const result = await runCommand(buildRecharge, [
        'billing',
        'balance',
        'recharge',
        '--channel',
        'alipay',
        '--amount',
        '1',
        '--format',
        format,
      ]);

      expect(result.exitCode).toBeUndefined();
      expect(createRecharge).toHaveBeenCalledOnce();
      expect(createRecharge).toHaveBeenCalledWith({ channel: 'alipay', amount: '1.00' });
      expect(waitForRechargeResult).not.toHaveBeenCalled();
      expect(getAvailableBalance).not.toHaveBeenCalled();
      expect(openBrowserSpy).not.toHaveBeenCalled();
      if (format === 'json') {
        expect(JSON.parse(result.stdout)).toEqual(createdOrder);
      } else {
        expect(result.stdout).toContain('Payment order created.');
        expect(result.stdout).not.toContain('RECHARGE ORDER ID');
        expect(result.stdout).toContain(createdOrder.paymentUrl);
        expect(result.stdout).not.toContain(`${String.fromCharCode(27)}[`);
      }
    },
  );
});

describe('billing balance recharge table flow', () => {
  it.each([
    ['compact', '\u2580'],
    ['full', `${String.fromCharCode(27)}[40m`],
  ] as const)(
    '%s mode appends the QR code only once after an actual resize',
    async (qrStyle, qrMarker) => {
      setStdinTTY(true);
      setQrCapableTerminal(20, qrStyle);
      let resolveResult: ((value: RechargeResultOutput) => void) | undefined;
      const createRecharge = vi.fn<CreateRecharge>(async () => createdOrder);
      const waitForRechargeResult = vi.fn<WaitForRechargeResult>(
        () =>
          new Promise((resolve) => {
            resolveResult = resolve;
          }),
      );
      const getAvailableBalance = vi.fn(async () => ({
        availableAmount: '12.34',
        currency: 'CNY',
      }));
      holder.services = makeMockServices({
        billingService: { createRecharge, waitForRechargeResult, getAvailableBalance },
      });
      renderInteractiveSpy.mockImplementation(async (element) => {
        const instance = render(React.createElement(React.Fragment));
        const stdin = instance.stdin as unknown as Record<string, unknown>;
        if (typeof stdin.resume !== 'function') stdin.resume = vi.fn();
        const stdout = instance.stdout as unknown as NodeJS.EventEmitter & { columns: number };
        Object.defineProperty(stdout, 'columns', { value: 20, configurable: true });
        const resizeListenersBefore = stdout.listenerCount('resize');
        instance.rerender(element);
        await vi.waitFor(() => {
          expect(stdout.listenerCount('resize')).toBeGreaterThan(resizeListenersBefore);
        });

        Object.defineProperty(stdout, 'columns', { value: 160, configurable: true });
        stdout.emit('resize');
        Object.defineProperty(stdout, 'columns', { value: 180, configurable: true });
        stdout.emit('resize');

        expect(resolveResult).toBeTypeOf('function');
        resolveResult?.(completedOrder);
        instance.unmount();
        await new Promise<void>((resolve) => setImmediate(resolve));
      });

      const result = await runCommand(buildRecharge, [
        'billing',
        'balance',
        'recharge',
        '--channel',
        'alipay',
        '--amount',
        '1.00',
        '--format',
        'table',
      ]);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('Widen the terminal to show it');
      expect(result.stdout).toContain(createdOrder.paymentUrl);
      // One initial fallback section and one successful append; the second resize
      // must not append a third section.
      expect(result.stdout.split('Alipay QR Code')).toHaveLength(3);
      expect(result.stdout).toContain(qrMarker);
      expect(result.stdout).not.toMatch(
        new RegExp(`${String.fromCharCode(27)}\\[[0-9]*[AJK]`, 'u'),
      );
      expect(appendRechargeQrBlockSpy).toHaveBeenCalledTimes(2);
      expect(writeRechargePaymentBlockSpy).toHaveBeenCalledOnce();
      expect(writeRechargePaymentBlockSpy.mock.results[0]?.value).toEqual({
        qrDrawn: false,
        qrAppendable: true,
      });
    },
  );

  it('stops retrying after an appended QR output error without changing the payment result', async () => {
    setStdinTTY(true);
    setQrCapableTerminal(20);
    const createRecharge = vi.fn<CreateRecharge>(async () => createdOrder);
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>(async () => completedOrder);
    const getAvailableBalance = vi.fn(async () => ({
      availableAmount: '12.34',
      currency: 'CNY',
    }));
    holder.services = makeMockServices({
      billingService: { createRecharge, waitForRechargeResult, getAvailableBalance },
    });
    appendRechargeQrBlockSpy.mockImplementation(() => {
      throw new Error('stdout unavailable');
    });
    renderInteractiveSpy.mockImplementation(async (element) => {
      const props = element.props as { onWidthChange?: (columns: number) => void };
      props.onWidthChange?.(80);
      props.onWidthChange?.(100);
    });

    const result = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--channel',
      'alipay',
      '--amount',
      '1.00',
      '--format',
      'table',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('Recharge completed.');
    expect(appendRechargeQrBlockSpy).toHaveBeenCalledOnce();
  });

  it('does not register a resize append when QR rendering is permanently unavailable', async () => {
    setStdinTTY(true);
    setQrCapableTerminal(20);
    process.env.QIANWEN_QR_STYLE = 'off';
    const createRecharge = vi.fn<CreateRecharge>(async () => createdOrder);
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>(async () => completedOrder);
    const getAvailableBalance = vi.fn(async () => ({
      availableAmount: '12.34',
      currency: 'CNY',
    }));
    holder.services = makeMockServices({
      billingService: { createRecharge, waitForRechargeResult, getAvailableBalance },
    });
    renderInteractiveSpy.mockImplementation(async (element) => {
      const props = element.props as { onWidthChange?: (columns: number) => void };
      expect(props.onWidthChange).toBeUndefined();
    });

    const result = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--channel',
      'alipay',
      '--amount',
      '1.00',
      '--format',
      'table',
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('QIANWEN_QR_STYLE=off');
    expect(appendRechargeQrBlockSpy).not.toHaveBeenCalled();
    expect(writeRechargePaymentBlockSpy.mock.results[0]?.value).toEqual({
      qrDrawn: false,
      qrAppendable: false,
    });
  });

  it('draws the QR code once as static text on a wide terminal', async () => {
    setStdinTTY(true);
    setQrCapableTerminal(120);
    const createRecharge = vi.fn<CreateRecharge>(async () => createdOrder);
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>(async () => completedOrder);
    const getAvailableBalance = vi.fn(async () => ({
      availableAmount: '12.34',
      currency: 'CNY',
    }));
    holder.services = makeMockServices({
      billingService: { createRecharge, waitForRechargeResult, getAvailableBalance },
    });

    const result = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--channel',
      'alipay',
      '--amount',
      '1.00',
      '--format',
      'table',
    ]);

    expect(result.exitCode).toBeUndefined();
    // QR is drawn exactly once as static text.
    expect(result.stdout.split('Alipay QR Code')).toHaveLength(2);
    // Compact mode uses half-block characters.
    expect(result.stdout).toContain('\u2580');
    // No width-insufficient fallback message.
    expect(result.stdout).not.toContain('Use the payment link above.');
    // The payment block writer reports QR was drawn.
    expect(writeRechargePaymentBlockSpy).toHaveBeenCalledOnce();
    expect(writeRechargePaymentBlockSpy.mock.results[0]?.value).toEqual({
      qrDrawn: true,
      qrAppendable: false,
    });
    const props = renderInteractiveSpy.mock.calls[0]?.[0].props as {
      onWidthChange?: (columns: number) => void;
    };
    expect(props.onWidthChange).toBeUndefined();
  });

  it('waits for a terminal result before querying balance and keeps success when balance fails', async () => {
    let resolveResult: ((value: RechargeResultOutput) => void) | undefined;
    const createRecharge = vi.fn<CreateRecharge>(async () => createdOrder);
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>(
      () =>
        new Promise((resolve) => {
          resolveResult = resolve;
        }),
    );
    const getAvailableBalance = vi.fn(async () => {
      throw new Error('balance unavailable');
    });
    holder.services = makeMockServices({
      billingService: { createRecharge, waitForRechargeResult, getAvailableBalance },
    });

    const commandPromise = runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--channel',
      'alipay',
      '--amount',
      '1.00',
      '--format',
      'table',
    ]);

    await vi.waitFor(() => expect(waitForRechargeResult).toHaveBeenCalledOnce());
    expect(getAvailableBalance).not.toHaveBeenCalled();
    resolveResult?.(completedOrder);

    const result = await commandPromise;
    expect(result.exitCode).toBeUndefined();
    expect(createRecharge).toHaveBeenCalledOnce();
    expect(waitForRechargeResult).toHaveBeenCalledWith({
      rechargeOrderId: createdOrder.rechargeOrderId,
      signal: expect.any(AbortSignal),
    });
    expect(getAvailableBalance).toHaveBeenCalledOnce();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(2);
    expect(renderWithInkSpy.mock.calls[0]?.[1]?.waitUntil).toBeInstanceOf(Promise);
    expect(renderWithInkSpy.mock.calls[1]?.[0].props).toMatchObject({ vm: undefined });
    expect(renderInteractiveSpy).not.toHaveBeenCalled();
    expect(openBrowserSpy).not.toHaveBeenCalled();
  });

  it('uses interactive rendering in a TTY and replaces WAIT in-place after Ctrl+C', async () => {
    setStdinTTY(true);
    const processListenersBefore = process.listenerCount('SIGINT');
    let finalInteractiveFrame = '';
    let testStdinListenersAfterUnmount = -1;
    const createRecharge = vi.fn<CreateRecharge>(async () => createdOrder);
    const waitForRechargeResult = vi.fn<WaitForRechargeResult>(
      ({ rechargeOrderId, signal }) =>
        new Promise((resolve) => {
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            resolve({
              type: 'recharge',
              rechargeOrderId,
              RechargeStatus: 'UNKNOWN',
              reason: 'interrupted',
            });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
    );
    const getAvailableBalance = vi.fn(async () => ({
      availableAmount: '12.34',
      currency: 'CNY',
    }));
    holder.services = makeMockServices({
      billingService: { createRecharge, waitForRechargeResult, getAvailableBalance },
    });
    renderInteractiveSpy.mockImplementation(async (element, options) => {
      expect(options).toEqual({
        altScreen: false,
        trailingNewline: true,
        protectStaticContent: true,
      });
      // The waiting frame owns stdin through a flowing-mode 'data' listener, so
      // ink-testing-library's stdin.write() (which emits 'data') drives it.
      const instance = render(React.createElement(React.Fragment));
      instance.rerender(element);
      await vi.waitFor(() => {
        // The frame attaches its 'data' listener in a passive effect.
        expect(instance.stdin.listenerCount('data')).toBeGreaterThan(0);
      });
      // The live frame paints nothing at all, so no resize redraw can leave a
      // residual row behind. Every visible line is static main-screen text.
      expect(instance.lastFrame() ?? '').toBe('');

      instance.stdin.write('\u0003');
      await vi.waitFor(() => {
        expect(waitForRechargeResult).toHaveBeenCalledOnce();
      });
      finalInteractiveFrame = instance.lastFrame() ?? '';
      instance.unmount();
      await new Promise<void>((resolve) => setImmediate(resolve));
      testStdinListenersAfterUnmount = instance.stdin.listenerCount('data');
    });

    const result = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--channel',
      'alipay',
      '--amount',
      '1.00',
      '--format',
      'table',
    ]);

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(130);
    expect(renderInteractiveSpy).toHaveBeenCalledOnce();
    expect(waitForRechargeResult).toHaveBeenCalledOnce();
    expect(getAvailableBalance).toHaveBeenCalledOnce();
    expect(renderWithInkSpy).toHaveBeenCalledOnce();
    // Nothing the user reads comes from the Ink frame. Ink's unmount appends a
    // lone newline when it detects a CI environment, so compare trimmed.
    expect(finalInteractiveFrame.trim()).toBe('');
    // The order and its exact link are static main-screen text, so the terminal
    // alone decides how the link wraps.
    expect(result.stdout).toContain(createdOrder.paymentUrl);
    expect(
      result.stdout.split('\n').filter((line) => line.trim() === createdOrder.paymentUrl),
    ).toHaveLength(1);
    expect(result.stdout).toContain('Waiting for payment...');
    // Notice wording is the unified single-press prompt.
    expect(result.stdout).toContain('Press Ctrl+C to stop.');
    // The settled interruption is written once, as static text.
    expect(result.stdout.split('Recharge Result')).toHaveLength(2);
    expect(result.stdout).toContain('Payment status monitoring stopped.');
    expect(result.stdout).toMatch(/STATUS\s+canceled/u);
    expect(result.stdout).not.toContain('FAILURE REASON');
    expect(testStdinListenersAfterUnmount).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(processListenersBefore);
    expect(openBrowserSpy).not.toHaveBeenCalled();
  });
});
