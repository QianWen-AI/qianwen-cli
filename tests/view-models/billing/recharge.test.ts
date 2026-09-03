import { describe, expect, it } from 'vitest';
import type {
  RechargeCreateOutput,
  RechargeHistoryOutput,
  RechargeResultOutput,
} from '../../../src/types/recharge.js';
import { RECHARGE_STATUS } from '../../../src/utils/recharge-status.js';
import {
  buildRechargeHistoryViewModel,
  buildRechargePaymentViewModel,
  buildRechargeResultViewModel,
  describeRechargeResult,
  formatRechargeAmount,
  RECHARGE_FAILURE_REASON,
} from '../../../src/view-models/billing/recharge.js';

describe('formatRechargeAmount', () => {
  it.each([
    ['100.00', 'CNY', '¥100.00 CNY'],
    ['0.01', 'USD', '$0.01 USD'],
    ['12.30', 'EUR', '12.30 EUR'],
  ])('formats %s %s without numeric conversion', (amount, currency, expected) => {
    expect(formatRechargeAmount(amount, currency)).toBe(expected);
  });

  it('preserves an amount above the JavaScript safe-integer range exactly', () => {
    expect(formatRechargeAmount('9007199254740991.99', 'CNY')).toBe('¥9007199254740991.99 CNY');
  });
});

describe('buildRechargePaymentViewModel', () => {
  it('projects a validated pending order without changing exact string fields', () => {
    const input: RechargeCreateOutput = {
      type: 'recharge',
      channel: 'alipay',
      amount: '9007199254740991.99',
      currency: 'CNY',
      status: 'pending',
      rechargeOrderId: 'order_sensitive_300000000000000000',
      paymentUrl: 'https://pay.test.qianwenai.com/checkout/value%2Fkept',
    };

    const output = buildRechargePaymentViewModel(input);

    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });
});

describe('buildRechargeResultViewModel', () => {
  it.each([
    RECHARGE_STATUS.WAIT,
    RECHARGE_STATUS.CHARGE_BACK,
    RECHARGE_STATUS.ACCTBOOK_SUCCESS,
    RECHARGE_STATUS.BIZACTION_SUCCESS,
    RECHARGE_STATUS.BIZNOTIFY_SUCCESS,
    RECHARGE_STATUS.DONE,
    RECHARGE_STATUS.FUND_FAILED,
    RECHARGE_STATUS.CANCEL,
  ])('preserves upstream status %s verbatim', (RechargeStatus) => {
    const input: RechargeResultOutput = {
      type: 'recharge',
      rechargeOrderId: 'order_sensitive_300000000000000000',
      RechargeStatus,
    };

    expect(buildRechargeResultViewModel(input)).toEqual({
      type: 'recharge',
      rechargeOrderId: input.rechargeOrderId,
      status: RechargeStatus,
    });
  });

  it('retains a local reason while dropping protocol and internal fields', () => {
    const input: RechargeResultOutput & { Nbid: string; internalTraceId: string } = {
      type: 'recharge',
      rechargeOrderId: 'order_sensitive_300000000000000000',
      RechargeStatus: 'FUTURE_STATUS',
      reason: 'unrecognized_status',
      Nbid: 'nbid_sensitive_2684201000001',
      internalTraceId: 'trace-internal-only',
    };

    const output = buildRechargeResultViewModel(input);

    expect(output).toEqual({
      type: 'recharge',
      rechargeOrderId: input.rechargeOrderId,
      status: 'FUTURE_STATUS',
      reason: 'unrecognized_status',
    });
    expect(output).not.toHaveProperty('RechargeStatus');
    expect(output).not.toHaveProperty('Nbid');
    expect(output).not.toHaveProperty('internalTraceId');
  });
});

describe('buildRechargeHistoryViewModel', () => {
  it('keeps only public record fields and drops backend transaction identifiers', () => {
    const input: RechargeHistoryOutput & {
      records: Array<
        RechargeHistoryOutput['records'][number] & {
          tradeId: string;
          oppositeTradeId: string;
          Nbid: string;
        }
      >;
    } = {
      startTime: '2026-08-23T00:00:00.000+08:00',
      endTime: '2026-08-25T23:59:59.999+08:00',
      page: 1,
      pageSize: 10,
      totalCount: 1,
      records: [
        {
          tradeTime: '2026-08-25T10:20:30.000+08:00',
          tradeType: 'CHARGE',
          tradeChannel: 'ALIPAY',
          amount: '10.00',
          currency: 'CNY',
          tradeId: 'trade-sensitive',
          oppositeTradeId: 'opposite-sensitive',
          Nbid: 'nbid_sensitive_2684201000001',
        },
      ],
    };

    const output = buildRechargeHistoryViewModel(input);

    expect(output).toEqual({
      startTime: input.startTime,
      endTime: input.endTime,
      page: 1,
      pageSize: 10,
      totalCount: 1,
      records: [
        {
          tradeTime: '2026-08-25T10:20:30.000+08:00',
          tradeType: 'CHARGE',
          tradeChannel: 'ALIPAY',
          amount: '10.00',
          currency: 'CNY',
        },
      ],
    });
    expect(output.records[0]).not.toHaveProperty('tradeId');
    expect(output.records[0]).not.toHaveProperty('oppositeTradeId');
    expect(output.records[0]).not.toHaveProperty('Nbid');
  });

  it('returns detached record objects', () => {
    const input: RechargeHistoryOutput = {
      startTime: '2026-08-23T00:00:00.000+08:00',
      endTime: '2026-08-25T23:59:59.999+08:00',
      page: 1,
      pageSize: 10,
      totalCount: 1,
      records: [
        {
          tradeTime: '2026-08-25T10:20:30.000+08:00',
          tradeType: 'CHARGE',
          tradeChannel: 'ALIPAY',
          amount: '10.00',
          currency: 'CNY',
        },
      ],
    };

    const output = buildRechargeHistoryViewModel(input);

    expect(output).not.toBe(input);
    expect(output.records).not.toBe(input.records);
    expect(output.records[0]).not.toBe(input.records[0]);
  });
});

describe('describeRechargeResult', () => {
  const balanceCommand = 'billing balance summary';
  const historyCommand = 'billing balance recharge-history';

  it.each([
    RECHARGE_STATUS.WAIT,
    RECHARGE_STATUS.CHARGE_BACK,
    RECHARGE_STATUS.ACCTBOOK_SUCCESS,
    RECHARGE_STATUS.BIZACTION_SUCCESS,
    RECHARGE_STATUS.BIZNOTIFY_SUCCESS,
  ])('describes %s as still processing', (status) => {
    expect(describeRechargeResult(status, undefined, balanceCommand, historyCommand)).toBe(
      'The recharge is still being processed.',
    );
  });

  it('describes FUND_FAILED and includes both recovery commands', () => {
    const message = describeRechargeResult(
      RECHARGE_STATUS.FUND_FAILED,
      undefined,
      balanceCommand,
      historyCommand,
    );

    expect(message).toContain('funds could not be deducted');
    expect(message).toContain(`'${historyCommand}'`);
    expect(message).toContain(`'${balanceCommand}'`);
  });

  it('describes CANCEL without claiming that a recharge succeeded', () => {
    const message = describeRechargeResult(
      RECHARGE_STATUS.CANCEL,
      undefined,
      balanceCommand,
      historyCommand,
    );

    expect(message).toContain('cancelled');
    expect(message).toContain('No recharge was confirmed');
    expect(message).toContain(`'${historyCommand}'`);
    expect(message).toContain(`'${balanceCommand}'`);
  });

  it('describes interruption as stopping only local monitoring', () => {
    const message = describeRechargeResult(
      'UNKNOWN',
      'interrupted',
      balanceCommand,
      historyCommand,
    );

    expect(message).toContain('Payment status monitoring stopped');
    expect(message).toContain('may still complete the payment');
    expect(message).toContain(`'${historyCommand}'`);
    expect(message).toContain(`'${balanceCommand}'`);
  });

  it('preserves the recovery guidance for an unrecognized upstream status', () => {
    const message = describeRechargeResult(
      'FUTURE_STATUS',
      'unrecognized_status',
      balanceCommand,
      historyCommand,
    );

    expect(message).toContain('unrecognized status');
    expect(message).toContain(`'${historyCommand}'`);
    expect(message).toContain(`'${balanceCommand}'`);
  });

  it('describes a local deadline as an inconclusive timeout', () => {
    const message = describeRechargeResult(
      'failed or timed out',
      RECHARGE_FAILURE_REASON,
      balanceCommand,
      historyCommand,
    );

    expect(message).toContain('timed out');
    expect(message).toContain('result is unknown');
    expect(message).not.toContain('failed');
    expect(message).toContain(`'${historyCommand}'`);
    expect(message).toContain(`'${balanceCommand}'`);
  });
});
