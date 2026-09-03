/**
 * Payment and recharge contracts shared by the service, command, and UI layers.
 */

/** Normalized result returned after creating an Alipay recharge order. */
export interface RechargeCreateOutput {
  type: 'recharge';
  channel: 'alipay';
  amount: string;
  currency: 'CNY';
  status: 'pending';
  rechargeOrderId: string;
  paymentUrl: string;
}

/** Terminal result retaining the status value returned by the recharge API. */
export interface RechargeResultOutput {
  type: 'recharge';
  rechargeOrderId: string;
  RechargeStatus: string;
  reason?: 'timed_out' | 'interrupted' | 'unrecognized_status';
}

/** One normalized recharge history record. */
export interface RechargeHistoryRecord {
  tradeTime: string;
  tradeType: 'CHARGE';
  tradeChannel: string;
  amount: string;
  currency: string;
}

/** Paginated recharge history returned to CLI renderers. */
export interface RechargeHistoryOutput {
  startTime: string;
  endTime: string;
  page: number;
  pageSize: number;
  totalCount: number;
  records: RechargeHistoryRecord[];
}
