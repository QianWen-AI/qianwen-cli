export interface PaymentChannelConfig {
  /** User-visible display name. */
  readonly name: string;
  /** MergePay fundChargeDTO.paymentType */
  readonly paymentType: string;
  /** MergePay fundChargeDTO.chargeType */
  readonly chargeType: string;
  /** MergePay fundChargeDTO.chargeTarget */
  readonly chargeTarget: string;
  /** MergePay fundChargeDTO.chargeTargetNo */
  readonly chargeTargetNo: string;
  /** MergePay fundChargeDTO.extendInfo */
  readonly extendInfo: Record<string, string>;
  /** Capability key matched in GetUserPaymentMethod for QR payments. */
  readonly capabilityKey: string;
  /** Commands and scenarios that support this channel. */
  readonly scopes: ReadonlyArray<string>;
}

export const SCOPE_TOKENPLAN_PURCHASE = 'tokenplan-purchase';
export const SCOPE_RECHARGE = 'recharge';

export const PAYMENT_CHANNELS: Record<string, PaymentChannelConfig> = {
  alipay: {
    name: 'Alipay',
    paymentType: 'PcCharge_PG',
    chargeType: 'PcCharge',
    chargeTarget: 'SpecifiedFunds',
    chargeTargetNo: 'BOOK_ALIYUN_CASH',
    extendInfo: { qrPay: 'true' },
    capabilityKey: 'PcCharge_PG',
    scopes: [SCOPE_TOKENPLAN_PURCHASE, SCOPE_RECHARGE],
  },
};

export const SUPPORTED_CHANNELS = Object.keys(PAYMENT_CHANNELS);
export const DEFAULT_CHANNEL = 'alipay';

export function getChannelsForScope(scope: string): string[] {
  return Object.entries(PAYMENT_CHANNELS)
    .filter(([, config]) => config.scopes.includes(scope))
    .map(([key]) => key);
}

/** Display name for the cash balance. */
export const CASH_BALANCE_DISPLAY = 'Cash balance';
