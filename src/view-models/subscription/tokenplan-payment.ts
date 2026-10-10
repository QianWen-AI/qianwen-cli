import type {
  TokenPlanPaymentResult,
  TokenPlanPaymentResultViewModel,
} from '../../types/tokenplan-payment.js';
import type { ExitCode } from '../../utils/exit-codes.js';

export function buildTokenPlanPaymentResultViewModel(
  result: TokenPlanPaymentResult,
): TokenPlanPaymentResultViewModel {
  const data: TokenPlanPaymentResult = {
    orderId: result.orderId,
    status: result.status,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.payStatusCode !== undefined ? { payStatusCode: result.payStatusCode } : {}),
  };
  const statusLabel: Record<TokenPlanPaymentResult['status'], string> = {
    succeeded: 'Succeeded',
    failed: 'Failed',
    cancelled: 'Canceled',
    pending: 'Pending',
    timed_out: 'Timed out',
    unknown: 'Unknown',
  };
  const guidance: Partial<Record<TokenPlanPaymentResult['status'], string>> = {
    failed: 'Check the order before trying again: qianwen subscription orders --type purchase',
    cancelled: 'The order was canceled. Start a new purchase only if needed.',
    pending: 'Use --wait or check the order: qianwen subscription orders --type purchase',
    timed_out:
      'Payment is still unconfirmed. Check the order before paying again: qianwen subscription orders --type purchase',
    unknown: 'Do not pay again. Check the order first: qianwen subscription orders --type purchase',
  };
  const fields = [
    { label: 'Order ID', value: data.orderId },
    { label: 'Payment status', value: statusLabel[data.status] },
    ...(guidance[data.status] ? [{ label: 'Next step', value: guidance[data.status]! }] : []),
  ];
  return {
    data,
    fields,
    note: 'Payment status does not confirm subscription activation. Check: qianwen subscription tokenplan status',
  };
}

export function tokenPlanPaymentResultExitCode(result: TokenPlanPaymentResult): ExitCode {
  if (result.reason === 'interrupted') return 130;
  switch (result.status) {
    case 'succeeded':
      return 0;
    case 'failed':
    case 'cancelled':
      return 1;
    case 'pending':
    case 'unknown':
    case 'timed_out':
      return 8;
  }
}
