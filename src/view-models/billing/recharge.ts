/**
 * Pure recharge view-model projections shared by JSON, text, and Ink output.
 */

import type {
  RechargeCreateOutput,
  RechargeHistoryOutput,
  RechargeResultOutput,
} from '../../types/recharge.js';
import { classifyRechargeStatus, RECHARGE_STATUS } from '../../utils/recharge-status.js';

export const RECHARGE_FAILURE_REASON = 'Payment could not be completed or timed out.';

/** View data for a newly-created recharge order. */
export interface RechargePaymentViewModel {
  readonly type: 'recharge';
  readonly channel: 'alipay';
  readonly amount: string;
  readonly currency: 'CNY';
  readonly status: 'pending';
  readonly rechargeOrderId: string;
  readonly paymentUrl: string;
}

/** View data for live waiting and final existing-order states. */
export interface RechargeResultViewModel {
  readonly type: 'recharge';
  readonly rechargeOrderId: string;
  readonly status: string;
  readonly reason?: typeof RECHARGE_FAILURE_REASON | 'interrupted' | 'unrecognized_status';
}

/** Final result subset returned after polling finishes. */
export type RechargeResultFinalViewModel = RechargeResultViewModel;

/** Human-readable status fields derived without changing the JSON contract. */
export interface RechargeResultDisplay {
  readonly status: string;
  readonly failureReason?: string;
}

// Label column shared by every recharge panel.
export const RECHARGE_LABEL_WIDTH = 20;

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { CNY: '¥', USD: '$' };
const RECHARGE_TIMEOUT_STATUS = 'failed or timed out';

/**
 * Format a payment amount for display.
 *
 * The amount stays a string throughout: routing it through `Number` would let
 * a payment figure pick up floating-point drift, which the recharge flow
 * forbids end to end.
 *
 * @param amount Normalized decimal string, already at two decimals.
 * @param currency ISO currency code from the order.
 */
export function formatRechargeAmount(amount: string, currency: string): string {
  return `${CURRENCY_SYMBOLS[currency] ?? ''}${amount} ${currency}`;
}

/** Human-facing message shown for a non-successful payment result. */
export function describeRechargeResult(
  status: RechargeResultViewModel['status'],
  reason: RechargeResultViewModel['reason'],
  balanceSummaryCommand = 'qianwen billing balance summary',
  rechargeHistoryCommand = 'qianwen billing balance recharge-history',
): string {
  if (status === RECHARGE_STATUS.FUND_FAILED) {
    return `Recharge failed because funds could not be deducted. Use '${rechargeHistoryCommand}' to view your recharge history and '${balanceSummaryCommand}' to check your available balance.`;
  }
  if (status === RECHARGE_STATUS.CANCEL) {
    return `The recharge order was cancelled. No recharge was confirmed. Use '${rechargeHistoryCommand}' to view your recharge history and '${balanceSummaryCommand}' to check your available balance.`;
  }
  if (reason === 'interrupted') {
    return `Payment status monitoring stopped. You may still complete the payment through the original payment page if the order remains payable. Use '${rechargeHistoryCommand}' to view your recharge history and '${balanceSummaryCommand}' to check your available balance.`;
  }
  if (reason === 'unrecognized_status') {
    return `The service returned an unrecognized status. If you have completed the payment, use '${rechargeHistoryCommand}' to view your recharge history and '${balanceSummaryCommand}' to check your available balance.`;
  }
  if (classifyRechargeStatus(status) === 'processing') {
    return 'The recharge is still being processed.';
  }
  return `Payment status monitoring has timed out and the recharge result is unknown. If you have completed the payment, use '${rechargeHistoryCommand}' to view your recharge history and '${balanceSummaryCommand}' to check your available balance.`;
}

/** Public fields displayed for one recharge fund-flow record. */
export interface RechargeHistoryRecordViewModel {
  readonly tradeTime: string;
  readonly tradeType: 'CHARGE';
  readonly tradeChannel: string;
  readonly amount: string;
  readonly currency: string;
}

/** Paginated recharge history view data. */
export interface RechargeHistoryViewModel {
  readonly startTime: string;
  readonly endTime: string;
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly records: readonly RechargeHistoryRecordViewModel[];
}

/**
 * Project a successful service result to the public payment view.
 *
 * @param value Validated service output.
 * @returns A detached pending-payment view model.
 */
export function buildRechargePaymentViewModel(
  value: RechargeCreateOutput,
): RechargePaymentViewModel {
  return { ...value };
}

/**
 * Project a polling result to the shared public result view.
 *
 * @param value Validated polling output.
 * @returns A detached final result view model.
 */
export function buildRechargeResultViewModel(
  value: RechargeResultOutput,
): RechargeResultFinalViewModel {
  const timedOut = value.reason === 'timed_out';
  const reason: RechargeResultViewModel['reason'] =
    value.reason === 'timed_out' ? RECHARGE_FAILURE_REASON : value.reason;
  return {
    type: value.type,
    rechargeOrderId: value.rechargeOrderId,
    status: timedOut ? RECHARGE_TIMEOUT_STATUS : value.RechargeStatus,
    ...(reason ? { reason } : {}),
  };
}

/** Map terminal results to the stable status vocabulary used by text and table output. */
export function buildRechargeResultDisplay(value: RechargeResultViewModel): RechargeResultDisplay {
  let status = value.status;
  if (value.reason === 'interrupted') status = 'canceled';
  else if (value.reason === RECHARGE_FAILURE_REASON) status = RECHARGE_TIMEOUT_STATUS;
  else {
    const disposition = classifyRechargeStatus(value.status);
    if (disposition === 'success') status = 'succeeded';
    else if (disposition === 'failure') status = 'failed';
  }

  return {
    status,
    ...(status === 'failed' || value.reason === RECHARGE_FAILURE_REASON
      ? { failureReason: RECHARGE_FAILURE_REASON }
      : {}),
  };
}

/**
 * Project fund-flow output while retaining only documented public fields.
 *
 * @param value Validated history service output.
 * @returns A detached recharge history view model.
 */
export function buildRechargeHistoryViewModel(
  value: RechargeHistoryOutput,
): RechargeHistoryViewModel {
  return {
    startTime: value.startTime,
    endTime: value.endTime,
    page: value.page,
    pageSize: value.pageSize,
    totalCount: value.totalCount,
    records: value.records.map((record) => ({
      tradeTime: record.tradeTime,
      tradeType: 'CHARGE',
      tradeChannel: record.tradeChannel,
      amount: record.amount,
      currency: record.currency,
    })),
  };
}
