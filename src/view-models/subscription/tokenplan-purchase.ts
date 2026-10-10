import { stripVTControlCharacters } from 'node:util';
import type {
  TokenPlanPurchasePreview,
  TokenPlanPurchaseResult,
  TokenPlanPaymentDisplayDetails,
} from '../../types/tokenplan-purchase.js';
import type { TokenPlanPurchaseDecision } from '../../services/tokenplan-purchase-service.js';
import { NO_TOKENPLAN_COUPON } from '../../api/parsers/tokenplan-trade.js';
import { DecimalAmount } from '../../utils/decimal-amount.js';
import {
  PAYMENT_CHANNELS,
  DEFAULT_CHANNEL,
  CASH_BALANCE_DISPLAY,
} from '../../config/payment-channels.js';
import { TOKEN_PLAN_UNPAID_ORDER_URL } from '../../services/tokenplan-urls.js';
import { findTokenPlanIndividualTierByType } from '../../types/tokenplan-tiers.js';

function text(value: string): string {
  return Array.from(stripVTControlCharacters(value))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
    .join('');
}

function amount(value: string | null, includeCurrency = true): string {
  if (value === null) return 'unknown';
  const [integer, fraction = ''] = value.split('.');
  return `¥${integer}.${fraction.padEnd(2, '0')}${includeCurrency ? ' CNY' : ''}`;
}

function deductionAmount(value: string): string {
  const formatted = amount(value);
  return DecimalAmount.parse(value).compare(DecimalAmount.parse('0')) === 0
    ? formatted
    : `-${formatted}`;
}

function field(label: string, value: string): string {
  return `${label.padEnd(22)}${value}`;
}

function seatRow(col1: string, col2: string): string {
  return `${col1.padEnd(22)}${col2}`;
}

function productFields(type: string): string[] {
  if (type === 'token_plan_team') return [field('PRODUCT', 'Token Plan Team')];
  const plan = findTokenPlanIndividualTierByType(type);
  return plan ? [field('PRODUCT', 'Token Plan Individual'), field('PLAN', plan.name)] : [];
}

function cycleName(cycle: TokenPlanPurchaseResult['billingCycle']): string {
  return { monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' }[cycle];
}

export function buildTokenPlanPaymentDisplay(details: TokenPlanPaymentDisplayDetails): string[] {
  const team = details.type === 'token_plan_team';
  const usesAlipay =
    DecimalAmount.parse(details.payableAmount).compare(DecimalAmount.parse('0')) > 0;
  return [
    field('ORDER ID', text(details.paymentOrderId)),
    ...(team
      ? [
          field('TYPE', text(details.type)),
          field('BILLING CYCLE', cycleName(details.billingCycle)),
          ...(details.totalSeats === undefined
            ? []
            : [field('TOTAL SEATS', String(details.totalSeats))]),
        ]
      : []),
    field('PAYABLE AMOUNT', amount(details.payableAmount)),
    field('CHANNEL', usesAlipay ? PAYMENT_CHANNELS[DEFAULT_CHANNEL].name : CASH_BALANCE_DISPLAY),
  ];
}

interface PurchasePromptOption {
  key: string;
  label: string;
  decision:
    | TokenPlanPurchaseDecision
    | { action: 'select-coupon' }
    | { action: 'custom-deduction' };
}

export function buildTokenPlanPurchasePreview(preview: TokenPlanPurchasePreview) {
  const balanceDeductionEditable =
    DecimalAmount.parse(preview.maxDeduction).compare(DecimalAmount.parse('0')) > 0 &&
    DecimalAmount.parse(preview.quote.amount).compare(DecimalAmount.parse('0')) > 0;
  const options: PurchasePromptOption[] = [
    ...(preview.deductionValid && preview.fundingPlan && preview.externalPayable !== null
      ? [
          {
            key: '1',
            label: (() => {
              const fp = preview.fundingPlan!;
              const hasCash = fp.cashDeduction !== '0';
              const hasExternal = fp.externalPayable !== '0';
              if (hasCash && hasExternal) {
                return `Apply ${amount(fp.cashDeduction, false)} cash and pay ${amount(fp.externalPayable, false)} with ${PAYMENT_CHANNELS[DEFAULT_CHANNEL].name}`;
              }
              if (hasCash && !hasExternal) {
                return 'Pay with cash balance (no Alipay QR needed)';
              }
              if (!hasCash && !hasExternal)
                return 'Confirm zero-amount order (no Alipay QR needed)';
              return `Pay ${amount(fp.externalPayable, false)} with ${PAYMENT_CHANNELS[DEFAULT_CHANNEL].name}`;
            })(),
            decision: { action: 'confirm' as const },
          },
        ]
      : []),
    ...(!preview.existingOrder && preview.quote.coupons.length > 0
      ? [
          {
            key: '2',
            label: 'Change or remove coupon',
            decision: { action: 'select-coupon' as const },
          },
        ]
      : []),
    ...(balanceDeductionEditable
      ? [
          {
            key: '3',
            label: 'Change balance deduction',
            decision: { action: 'custom-deduction' as const },
          },
        ]
      : []),
    { key: '0', label: 'Cancel purchase', decision: { action: 'cancel' } },
  ];
  const couponOptions: PurchasePromptOption[] = [
    ...preview.quote.coupons.map((coupon, index) => {
      const isCurrent = coupon.id === preview.quote.coupon;
      const nameTag = text(coupon.name) + (isCurrent ? ' (current)' : '') + '';
      const details: string[] = [];
      if (coupon.balance) details.push(`   Available balance: ${amount(coupon.balance, false)}`);
      if (coupon.faceValue)
        details.push(`   Face value:        ${amount(coupon.faceValue, false)}`);
      if (coupon.validUntil) details.push(`   Valid until:       ${coupon.validUntil}`);
      if (isCurrent) details.push('   Current selection');
      const label = details.length > 0 ? `${nameTag}\n${details.join('\n')}` : nameTag;
      return {
        key: String(index + 1),
        label,
        decision: { action: 'coupon' as const, coupon: coupon.id },
      };
    }),
    {
      key: '0',
      label: 'Do not use a coupon',
      decision: { action: 'coupon', coupon: NO_TOKENPLAN_COUPON },
    },
  ];
  const seats = preview.selection.seats.filter((seat) => seat.quantity > 0);
  const seatNames: Record<string, string> = {
    standard: 'Standard Seat',
    pro: 'Pro Seat',
    max: 'Max Seat',
  };
  const selectedCouponObj = preview.quote.coupons.find(
    (coupon) => coupon.id === preview.quote.coupon,
  );
  const selectedCoupon =
    preview.quote.coupon === NO_TOKENPLAN_COUPON
      ? 'None'
      : (selectedCouponObj ? text(selectedCouponObj.name) : '') || 'unknown';
  const selectedCouponLabel = selectedCouponObj?.recommended
    ? `${selectedCoupon} (Recommended)`
    : selectedCoupon;
  const balanceDeductionHint = balanceDeductionEditable
    ? preview.deductionIntent === 'auto'
      ? ' (default; editable)'
      : ' (editable)'
    : '';
  return {
    title: preview.existingOrder ? 'CONFIRM EXISTING ORDER PAYMENT' : 'TOKEN PLAN PURCHASE',
    lines: [
      ...(!preview.existingOrder
        ? [
            'Each quote is based on your current selections.',
            'It is refreshed before purchase, so amounts may change.',
          ]
        : []),
      ...(preview.changed ? ['Quote or selection changed. Review and confirm again.'] : []),
      ...(preview.existingOrder
        ? [
            'The order already exists. This confirmation does not create another order or change coupons.',
            field('ORDER ID', text(preview.existingOrder.paymentOrderId)),
            field('ORDER IDS', preview.existingOrder.orderIds.map(text).join(', ')),
            field(
              'PREVIOUS ORDER AMOUNT',
              amount(preview.existingOrder.confirmedFundingPlan.orderPayable),
            ),
            field(
              'PREVIOUS CASH',
              amount(preview.existingOrder.confirmedFundingPlan.cashDeduction),
            ),
            field(
              'PREVIOUS ALIPAY',
              amount(preview.existingOrder.confirmedFundingPlan.externalPayable),
            ),
          ]
        : []),
      field('TYPE', text(preview.selection.type)),
      ...productFields(preview.selection.type),
      field('BILLING CYCLE', cycleName(preview.selection.billingCycle)),
      ...(preview.selection.edition === 'team'
        ? (() => {
            const totalQty = seats.reduce((sum, seat) => sum + seat.quantity, 0);
            return [
              '',
              seatRow('SEAT TYPE', 'QUANTITY'),
              ...seats.map((seat) => {
                const name = seatNames[seat.specCode] ?? 'unknown';
                return seatRow(name, String(seat.quantity));
              }),
              seatRow('TOTAL SEATS', String(totalQty)),
              '',
            ];
          })()
        : []),
      ...(DecimalAmount.parse(preview.quote.originalAmount).compare(
        DecimalAmount.parse(preview.quote.planAmount),
      ) > 0
        ? [field('ORIGINAL AMOUNT', amount(preview.quote.originalAmount))]
        : []),
      field('PLAN AMOUNT', amount(preview.quote.planAmount)),
      '',
      field('SELECTED COUPON', selectedCouponLabel),
      ...(selectedCouponObj && selectedCouponObj.id !== NO_TOKENPLAN_COUPON
        ? [
            ...(selectedCouponObj.balance
              ? [field('COUPON BALANCE', amount(selectedCouponObj.balance))]
              : []),
            ...(selectedCouponObj.faceValue
              ? [field('COUPON FACE VALUE', amount(selectedCouponObj.faceValue))]
              : []),
            ...(selectedCouponObj.validUntil
              ? [field('COUPON VALID UNTIL', selectedCouponObj.validUntil)]
              : []),
            ...(DecimalAmount.parse(preview.quote.couponDeduction).compare(
              DecimalAmount.parse('0'),
            ) > 0
              ? [field('COUPON DEDUCTION', deductionAmount(preview.quote.couponDeduction))]
              : []),
          ]
        : []),
      '',
      field('ACCOUNT BALANCE', amount(preview.balance)),
      field(
        'BALANCE DEDUCTION',
        `${deductionAmount(preview.balanceDeduction)}${balanceDeductionHint}`,
      ),
      '',
      field(
        'PAYABLE AMOUNT',
        preview.externalPayable === '0'
          ? '¥0.00 CNY (No Alipay QR needed)'
          : amount(preview.externalPayable),
      ),
      field('AUTO-RENEW', preview.selection.autoRenew ? 'Enabled' : 'Disabled'),
      ...(!preview.deductionValid
        ? [
            'Your current balance deduction cannot be applied to the updated quote.',
            `Current balance deduction: ${amount(preview.balanceDeduction)}`,
            `Maximum deduction: ${amount(preview.maxDeduction)}`,
            'Choose a custom amount, maximum cash or no cash before confirming.',
          ]
        : []),
      ...(preview.deductionValid && preview.externalPayable === null
        ? ['Payable amount is unknown. Payment cannot be confirmed.']
        : []),
    ],
    options,
    couponOptions,
  };
}

export function buildTokenPlanPurchaseResult(result: TokenPlanPurchaseResult) {
  const beforeCreate =
    result.stage === 'preflight' && result.paymentOrderId === null && result.orderIds === null;
  const headline =
    result.status === 'succeeded'
      ? result.activationStatus === 'visible'
        ? '✓ Token Plan activated.'
        : '✓ Token Plan purchase successful.'
      : result.status === 'pending'
        ? 'Payment pending. Use subscription orders to check status.'
        : result.status === 'cancelled'
          ? result.reason === 'order_cancelled'
            ? '✗ Order canceled.'
            : beforeCreate
              ? '✗ Payment canceled.'
              : '✗ Purchase stopped.'
          : result.status === 'timed_out'
            ? '✗ Payment confirmation timed out.'
            : result.status === 'unknown'
              ? result.stage === 'create'
                ? result.paymentOrderId !== null
                  ? 'Order was created but payment could not proceed.'
                  : 'Order creation outcome is unknown.'
                : beforeCreate
                  ? 'Purchase checks could not be completed.'
                  : 'Payment outcome is unknown.'
              : result.stage === 'payment'
                ? '✗ Payment failed.'
                : '✗ Purchase could not be completed.';
  const recovery = result.paymentOrderId
    ? 'qianwen subscription orders --type purchase'
    : result.stage === 'create'
      ? 'qianwen subscription orders --type purchase'
      : null;
  const recoveryUrl = result.paymentOrderId ? TOKEN_PLAN_UNPAID_ORDER_URL : null;
  const basicFields: string[] = [
    field('TYPE', text(result.type)),
    ...productFields(result.type),
    field('BILLING CYCLE', cycleName(result.billingCycle)),
  ];

  let lines: string[];

  if (result.status === 'cancelled' && beforeCreate) {
    // Cancelled before order creation: minimal display
    lines = [
      headline,
      'No order was created. No payment was made.',
      '',
      ...basicFields,
      field('AUTO-RENEW', result.requestedAutoRenew ? 'Enabled' : 'Disabled'),
    ];
  } else if (beforeCreate) {
    // Preflight failed/unknown before order creation: basic info + error
    lines = [headline, 'No Token Plan was activated. No payment was created.', '', ...basicFields];
  } else {
    // Post-create (succeeded/failed/timed_out/cancelled/unknown): full display
    lines = [
      headline,
      ...(result.paymentAttempted === false && result.status !== 'succeeded'
        ? ['No Token Plan was activated. No payment was created.']
        : []),
      ...(result.stage === 'create' && result.paymentOrderId && result.status !== 'succeeded'
        ? ['An order was created; the purchase is not complete.']
        : []),
      ...(result.status === 'cancelled'
        ? [
            result.reason === 'order_cancelled'
              ? 'The order was canceled. No payment was completed.'
              : 'Stopping the CLI does not cancel an existing order or payment.',
          ]
        : []),
      field('STATUS', result.status),
      field('STAGE', result.stage),
      ...basicFields,
      field('QUOTED AMOUNT', amount(result.amount)),
      ...(result.settledAmount !== undefined
        ? [field('SETTLED AMOUNT', amount(result.settledAmount))]
        : []),
      field('ORDER ID', result.paymentOrderId ?? 'unknown'),
      ...(result.paymentUrl !== undefined ? [field('PAYMENT URL', result.paymentUrl)] : []),
      field(
        'CHANNEL',
        result.cashDeduction &&
          result.cashDeduction !== '0' &&
          (!result.externalPayable || result.externalPayable === '0')
          ? CASH_BALANCE_DISPLAY
          : PAYMENT_CHANNELS[DEFAULT_CHANNEL].name,
      ),
      field('BALANCE DEDUCTION', result.cashDeduction ? amount(result.cashDeduction) : 'None'),
      field('ALIPAY PAYABLE', amount(result.externalPayable ?? null)),
      field(
        'AUTO-RENEW',
        result.status === 'succeeded' && result.autoRenewStatus !== 'unknown'
          ? { enabled: 'Enabled', disabled: 'Disabled', unknown: 'Unknown' }[result.autoRenewStatus]
          : result.requestedAutoRenew
            ? 'Enabled'
            : 'Disabled',
      ),
      ...(result.status === 'succeeded' ? [field('ACTIVATION', result.activationStatus)] : []),
      ...(result.status === 'succeeded' && result.period
        ? [field('PERIOD', `${result.period.start} \u2013 ${result.period.end}`)]
        : []),
      ...(result.seatSummary && result.seatSummary.length > 0
        ? [
            '',
            field('SEAT TYPE', 'QUANTITY'),
            ...result.seatSummary.map((s) => field(s.type, String(s.quantity))),
          ]
        : []),
      ...(result.status === 'succeeded'
        ? [
            result.activationStatus === 'visible'
              ? result.type === 'token_plan_team'
                ? 'Your Team Token Plan subscription is visible; individual seat fulfillment is not confirmed here.'
                : 'Your Individual Token Plan subscription is visible.'
              : 'Token Plan activation is not yet confirmed.',
          ]
        : []),
      ...(recovery && result.status !== 'succeeded'
        ? [
            `Check order status: ${recovery}`,
            ...(recoveryUrl ? [`Cancel or manage orders at: ${recoveryUrl}`] : []),
            'Do not retry purchase or payment while the outcome is unknown.',
          ]
        : []),
      ...(result.paymentAttempted !== false &&
      result.status !== 'succeeded' &&
      result.status !== 'pending'
        ? [
            result.status === 'timed_out'
              ? 'Payment confirmation timed out. Check your Token Plan status before trying again.'
              : 'Before trying again, check your Token Plan status: qianwen subscription tokenplan status',
          ]
        : []),
      ...(result.status === 'succeeded'
        ? ['To check the activation status, run:', '  qianwen subscription tokenplan status']
        : []),
      ...(result.settlementDrifted === true
        ? [
            result.paymentAttempted
              ? 'Payment uses the reconfirmed funding plan for this order.'
              : 'The payment plan changed. No payment was attempted by this CLI.',
          ]
        : []),
      ...(result.warning !== undefined ? [field('WARNING', result.warning)] : []),
    ];
  }

  return {
    title: 'TOKEN PLAN PURCHASE RESULT',
    data: {
      stage: result.stage,
      status: result.status,
      type: result.type,
      billingCycle: result.billingCycle,
      amount: result.amount,
      currency: result.currency,
      requestedAutoRenew: result.requestedAutoRenew,
      autoRenewStatus: result.autoRenewStatus,
      paymentOrderId: result.paymentOrderId,
      orderIds: result.orderIds,
      activationStatus: result.activationStatus,
      ...(result.paymentMode !== undefined && { paymentMode: result.paymentMode }),
      ...(result.cashDeduction !== undefined && { cashDeduction: result.cashDeduction }),
      ...(result.externalPayable !== undefined && { externalPayable: result.externalPayable }),
      ...(result.settledAmount !== undefined && { settledAmount: result.settledAmount }),
      ...(result.settlementDrifted !== undefined && {
        settlementDrifted: result.settlementDrifted,
      }),
      ...(result.paymentAttempted !== undefined && { paymentAttempted: result.paymentAttempted }),
      ...(result.paymentUrl !== undefined && { paymentUrl: result.paymentUrl }),
      ...(result.reason !== undefined && { reason: result.reason }),
      ...(result.warning !== undefined && { warning: result.warning }),
      ...(result.period !== undefined && { period: result.period }),
      ...(result.seatSummary !== undefined && { seatSummary: result.seatSummary }),
    },
    lines,
  };
}

export type TokenPlanPurchasePreviewViewModel = ReturnType<typeof buildTokenPlanPurchasePreview>;
export type TokenPlanPurchaseResultViewModel = ReturnType<typeof buildTokenPlanPurchaseResult>;
