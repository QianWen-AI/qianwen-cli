import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { RechargeBalanceInk } from '../../src/ui/RechargeBalance.js';
import { RechargeHistoryInk } from '../../src/ui/RechargeHistory.js';
import { RechargeResultInk, RechargeResultPollingInk } from '../../src/ui/RechargeResult.js';
import type {
  RechargeHistoryViewModel,
  RechargePaymentViewModel,
  RechargeResultFinalViewModel,
} from '../../src/view-models/billing/recharge.js';
import { RECHARGE_FAILURE_REASON } from '../../src/view-models/billing/recharge.js';

const PAYMENT_URL = 'https://pay.test.qianwenai.com/checkout/ui-test';
const payment: RechargePaymentViewModel = {
  type: 'recharge',
  channel: 'alipay',
  amount: '100.00',
  currency: 'CNY',
  status: 'pending',
  rechargeOrderId: 'order-ui-test',
  paymentUrl: PAYMENT_URL,
};

function count(text: string, value: string): number {
  return text.split(value).length - 1;
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// The order fields, payment link, and QR code are written as static main-screen
// text rather than rendered by Ink; they are covered by
// tests/ui/rechargePaymentOutput.test.ts.

describe('RechargeResultInk', () => {
  it('shows only the waiting state while polling without exposing the polling window', () => {
    const instance = render(
      <RechargeResultInk
        vm={{ type: 'recharge', rechargeOrderId: 'order-wait', status: 'WAIT' }}
        polling
      />,
    );
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    expect(frame).toContain('Waiting for payment...');
    expect(frame).not.toContain('POLLING WINDOW');
    expect(frame).not.toContain('2 hours');
    expect(frame).not.toContain('RECHARGE ORDER ID');
  });

  it('shows the successful terminal state as succeeded', () => {
    const instance = render(
      <RechargeResultInk
        vm={{ type: 'recharge', rechargeOrderId: 'order-done', status: 'DONE' }}
      />,
    );
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    expect(frame).toContain('Recharge completed.');
    expect(frame).not.toContain('order-done');
    expect(frame).toMatch(/STATUS\s+succeeded/u);
    expect(frame).not.toContain('DONE');
  });

  it.each([
    ['FUND_FAILED', undefined, 'failed', 'Recharge failed or timed out.', true],
    ['UNKNOWN', 'interrupted' as const, 'canceled', 'Payment status monitoring stopped', false],
    [
      'failed or timed out',
      RECHARGE_FAILURE_REASON,
      'failed or timed out',
      'Recharge failed or timed out.',
      true,
    ],
    [
      'FUTURE_STATUS',
      'unrecognized_status' as const,
      'FUTURE_STATUS',
      'unrecognized status',
      false,
    ],
  ] as const)(
    'maps %s to the corresponding human-readable result',
    (status, reason, displayStatus, message, hasFailureReason) => {
      const instance = render(
        <RechargeResultInk
          vm={{ type: 'recharge', rechargeOrderId: 'order-final', status, reason }}
        />,
      );
      const frame = instance.lastFrame() ?? '';
      instance.unmount();
      expect(frame).toContain(message);
      expect(frame).toMatch(new RegExp(`STATUS\\s+${displayStatus}`, 'u'));
      if (hasFailureReason) {
        expect(frame).toMatch(/FAILURE REASON\s+Payment could not be completed or timed out\./u);
      } else {
        expect(frame).not.toContain('FAILURE REASON');
      }
    },
  );
});

describe('RechargeResultPollingInk', () => {
  it('replaces WAIT with the final state in the same result panel', async () => {
    let resolveResult: (value: RechargeResultFinalViewModel) => void = () => {};
    const resultPromise = new Promise<RechargeResultFinalViewModel>((resolve) => {
      resolveResult = resolve;
    });
    const onFinalRender = vi.fn();
    const instance = render(
      <RechargeResultPollingInk
        rechargeOrderId="order-poll"
        resultPromise={resultPromise}
        showCancelHint
        onFinalRender={onFinalRender}
      />,
    );

    expect(instance.lastFrame()).toContain('Waiting for payment...');
    expect(instance.lastFrame()).toContain('Press Ctrl+C to stop.');

    resolveResult({ type: 'recharge', rechargeOrderId: 'order-poll', status: 'DONE' });
    await flushEffects();
    await vi.waitFor(() => expect(onFinalRender).toHaveBeenCalledTimes(1));
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    expect(frame).toContain('Recharge completed.');
    expect(frame).toMatch(/STATUS\s+succeeded/u);
    expect(frame).not.toContain('Waiting for payment...');
    expect(frame).not.toContain('Press Ctrl+C to stop.');
    expect(count(frame, 'Recharge Result')).toBe(1);
  });

  it('replaces the waiting state with unknown on query failure without inventing a terminal state', async () => {
    let rejectResult: (reason: unknown) => void = () => {};
    const resultPromise = new Promise<RechargeResultFinalViewModel>((_resolve, reject) => {
      rejectResult = reject;
    });
    void resultPromise.catch(() => undefined);
    const instance = render(
      <RechargeResultPollingInk rechargeOrderId="order-error" resultPromise={resultPromise} />,
    );
    rejectResult(new Error('network down'));
    await flushEffects();
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    expect(frame).toContain('Payment result query stopped with an error.');
    expect(frame).toContain('unknown');
    expect(frame).not.toContain('order-error');
    expect(frame).not.toContain('Waiting for payment...');
    expect(count(frame, 'Recharge Result')).toBe(1);
  });
});

describe('RechargeBalanceInk', () => {
  it('shows a successfully queried balance', () => {
    const instance = render(
      <RechargeBalanceInk
        vm={{
          availableAmount: '12.34',
          currency: 'CNY',
          displayAmount: '¥12.34',
        }}
      />,
    );
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    expect(frame).toContain('Balance');
    expect(frame).toContain('¥12.34 CNY');
  });

  it('suggests a separate retry when balance lookup fails without overriding the result', () => {
    const instance = render(<RechargeBalanceInk />);
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    expect(frame).toContain('Balance is unavailable right now.');
    expect(frame).toContain('qianwen billing balance summary');
  });
});

const historyVm: RechargeHistoryViewModel = {
  startTime: '2026-08-01T00:00:00+08:00',
  endTime: '2026-08-31T23:59:59+08:00',
  page: 1,
  pageSize: 10,
  totalCount: 2,
  records: [
    {
      tradeTime: '2026-08-12T10:30:00+08:00',
      tradeType: 'CHARGE',
      tradeChannel: 'alipay',
      amount: '100.00',
      currency: 'CNY',
    },
    {
      tradeTime: '2026-08-20T18:05:00+08:00',
      tradeType: 'CHARGE',
      tradeChannel: 'alipay',
      amount: '20.50',
      currency: 'CNY',
    },
  ],
};

describe('RechargeHistoryInk', () => {
  it('renders the date range, pagination footer, and one row per record', () => {
    const instance = render(<RechargeHistoryInk vm={historyVm} />);
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    expect(frame).toContain('Recharge History');
    expect(frame).toContain('2026-08-01 00:00:00 → 2026-08-31 23:59:59');
    expect(frame).toContain('Page 1 · 10 per page · 2 total');
    expect(frame).toContain('2026-08-12 10:30:00');
    expect(frame).toContain('2026-08-20 18:05:00');
    expect(frame).toContain('100.00 CNY');
    expect(frame).toContain('20.50 CNY');
  });

  it('shows an explicit empty state instead of a bare table', () => {
    const instance = render(
      <RechargeHistoryInk vm={{ ...historyVm, totalCount: 0, records: [] }} />,
    );
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    expect(frame).toContain('No recharge records');
    expect(frame).not.toContain('CHARGE');
  });
});
