import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderTextRechargeHistory,
  renderTextRechargePayment,
  renderTextRechargeResult,
} from '../../../src/output/text/billing.js';
import type {
  RechargeHistoryViewModel,
  RechargePaymentViewModel,
  RechargeResultViewModel,
} from '../../../src/view-models/billing/recharge.js';

// The text format is the machine-readable contract: plain stdout lines with
// no ANSI escapes, consumable by grep / agent pipelines.

let lines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  lines = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

const payment: RechargePaymentViewModel = {
  type: 'recharge',
  channel: 'alipay',
  amount: '100.00',
  currency: 'CNY',
  status: 'pending',
  rechargeOrderId: 'order-text-test',
  paymentUrl: 'https://pay.test.qianwenai.com/checkout/text-test',
};

const history: RechargeHistoryViewModel = {
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

describe('renderTextRechargePayment', () => {
  it('prints the order fields and the copyable payment link', () => {
    renderTextRechargePayment(payment);

    const output = lines.join('\n');
    expect(output).toContain('Payment order created.');
    expect(output).toMatch(/TYPE\s+recharge/u);
    expect(output).toMatch(/CHANNEL\s+alipay/u);
    expect(output).toMatch(/AMOUNT\s+¥100\.00 CNY/u);
    // The URL stays on its own unprefixed line so terminals can select/copy it.
    expect(lines).toContain(payment.paymentUrl);
  });

  it('never leaks the internal order id or ANSI escapes', () => {
    renderTextRechargePayment(payment);

    const output = lines.join('\n');
    expect(output).not.toContain('order-text-test');
    expect(output).not.toContain('\u001b');
  });
});

describe('renderTextRechargeResult', () => {
  const result = (status: string, reason?: RechargeResultViewModel['reason']) =>
    ({
      type: 'recharge',
      rechargeOrderId: 'order-result',
      status,
      reason,
    }) as RechargeResultViewModel;

  it('reports a settled order as completed with the succeeded status', () => {
    renderTextRechargeResult(result('DONE'));

    const output = lines.join('\n');
    expect(output).toContain('Recharge completed.');
    expect(output).toMatch(/STATUS\s+succeeded/u);
    expect(output).not.toContain('FAILURE REASON');
    expect(output).not.toContain('order-result');
  });

  it('reports a fund failure with the retry guidance and a failure reason', () => {
    renderTextRechargeResult(result('FUND_FAILED'));

    const output = lines.join('\n');
    expect(output).toContain('Recharge failed or timed out.');
    expect(output).toContain('Before trying again, check your balance');
    expect(output).toContain('qianwen billing balance summary');
    expect(output).toMatch(/STATUS\s+failed/u);
    expect(output).toMatch(/FAILURE REASON\s+Payment could not be completed or timed out\./u);
  });

  it('keeps a still-processing order in its non-terminal wording', () => {
    renderTextRechargeResult(result('WAIT'));

    const output = lines.join('\n');
    expect(output).toContain('The recharge is still being processed.');
    expect(output).not.toContain('Recharge completed.');
    expect(output).not.toContain('Recharge failed or timed out.');
  });

  it('explains an interrupted monitoring run without inventing a terminal state', () => {
    renderTextRechargeResult(result('UNKNOWN', 'interrupted'));

    const output = lines.join('\n');
    expect(output).toContain('Payment status monitoring stopped');
    expect(output).toMatch(/STATUS\s+canceled/u);
  });
});

describe('renderTextRechargeHistory', () => {
  it('prints the Shanghai date range, pagination, and one row per record', () => {
    renderTextRechargeHistory(history);

    const output = lines.join('\n');
    expect(output).toContain('2026-08-01 00:00:00 → 2026-08-31 23:59:59');
    expect(output).toContain('1 (10 per page, 2 total)');
    expect(output).toContain('2026-08-12 10:30:00');
    expect(output).toContain('2026-08-20 18:05:00');
    expect(output).toContain('CHARGE');
    expect(output).toContain('alipay');
    expect(output).toContain('100.00 CNY');
    expect(output).toContain('20.50 CNY');
  });

  it('reports an empty page explicitly instead of printing a bare table', () => {
    renderTextRechargeHistory({ ...history, totalCount: 0, records: [] });

    const output = lines.join('\n');
    expect(output).toContain('No recharge records.');
    expect(output).not.toContain('CHARGE');
  });

  it('emits no ANSI escapes', () => {
    renderTextRechargeHistory(history);

    expect(lines.join('\n')).not.toContain('\u001b');
  });
});
