export interface TokenPlanCreatedOrders {
  paymentOrderId: string;
  orderIds: string[];
}

export interface TokenPlanMergePayInput {
  paymentOrderId: string;
  amount: string;
  balanceDeduction: string;
  channel?: string;
  signal?: AbortSignal;
  /** Called immediately before the transport invokes fetch. */
  onRequestStart?: () => void;
}

export interface TokenPlanMergePayResult {
  status: 'succeeded' | 'pending' | 'failed' | 'unknown';
  url: string | null;
  reason?: string;
}

export interface TokenPlanPaymentResult {
  orderId: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'pending' | 'timed_out' | 'unknown';
  reason?: string;
  payStatusCode?: string;
}

export interface TokenPlanPaymentWaitOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface TokenPlanPaymentResultViewModel {
  data: TokenPlanPaymentResult;
  fields: Array<{ label: string; value: string }>;
  note: string;
}

export interface CashPaymentCapabilities {
  admissionResult: 'supported' | 'unsupported' | 'unknown';
  cashMethod: { available: string; currency: 'CNY' } | null;
  alipayScanning: boolean;
  identityContext: { site: string; nbid: string };
  unsupportedReason?: string;
}

export interface CashFundingPlan {
  paymentMode: 'cash_alipay';
  deductionIntent: 'auto' | 'manual' | 'none';
  orderPayable: string;
  cashDeduction: string;
  externalPayable: string;
}

export interface TokenPlanSettlementInfo {
  settledPayable: string;
  orderId: string;
  currency: 'CNY';
}
