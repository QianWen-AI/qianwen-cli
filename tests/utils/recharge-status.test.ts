import { describe, expect, it } from 'vitest';
import { classifyRechargeStatus, RECHARGE_STATUS } from '../../src/utils/recharge-status.js';

describe('classifyRechargeStatus', () => {
  it.each([
    RECHARGE_STATUS.WAIT,
    RECHARGE_STATUS.CHARGE_BACK,
    RECHARGE_STATUS.ACCTBOOK_SUCCESS,
    RECHARGE_STATUS.BIZACTION_SUCCESS,
    RECHARGE_STATUS.BIZNOTIFY_SUCCESS,
  ])('classifies %s as processing', (status) => {
    expect(classifyRechargeStatus(status)).toBe('processing');
  });

  it('classifies DONE as the only successful status', () => {
    expect(classifyRechargeStatus(RECHARGE_STATUS.DONE)).toBe('success');
  });

  it.each([RECHARGE_STATUS.FUND_FAILED, RECHARGE_STATUS.CANCEL])(
    'classifies %s as a terminal failure',
    (status) => {
      expect(classifyRechargeStatus(status)).toBe('failure');
    },
  );

  it.each(['done', ' Done ', 'WAIT ', ' wait', 'POLLING TIMEOUT', 'UNKNOWN', ''])(
    'does not normalize or infer the unknown status %j',
    (status) => {
      expect(classifyRechargeStatus(status)).toBe('unknown');
    },
  );
});
