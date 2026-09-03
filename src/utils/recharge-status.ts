/** Upstream recharge statuses documented by GetRechargeResult. */
export const RECHARGE_STATUS = {
  FUND_FAILED: 'FUND_FAILED',
  CANCEL: 'CANCEL',
  WAIT: 'WAIT',
  CHARGE_BACK: 'CHARGE_BACK',
  ACCTBOOK_SUCCESS: 'ACCTBOOK_SUCCESS',
  BIZACTION_SUCCESS: 'BIZACTION_SUCCESS',
  BIZNOTIFY_SUCCESS: 'BIZNOTIFY_SUCCESS',
  DONE: 'DONE',
} as const;

/** Polling decision derived from an upstream recharge status. */
export type RechargeStatusDisposition = 'processing' | 'success' | 'failure' | 'unknown';

/**
 * Classify an upstream status without normalizing its spelling or enforcing a
 * transition order. The service may skip or repeat intermediate states.
 *
 * @param status Raw RechargeStatus returned by GetRechargeResult.
 * @returns Whether polling should continue or stop with a known/unknown result.
 */
export function classifyRechargeStatus(status: string): RechargeStatusDisposition {
  switch (status) {
    case RECHARGE_STATUS.WAIT:
    case RECHARGE_STATUS.CHARGE_BACK:
    case RECHARGE_STATUS.ACCTBOOK_SUCCESS:
    case RECHARGE_STATUS.BIZACTION_SUCCESS:
    case RECHARGE_STATUS.BIZNOTIFY_SUCCESS:
      return 'processing';
    case RECHARGE_STATUS.DONE:
      return 'success';
    case RECHARGE_STATUS.FUND_FAILED:
    case RECHARGE_STATUS.CANCEL:
      return 'failure';
    default:
      return 'unknown';
  }
}
