import { CliError } from '../../utils/errors.js';
import { DecimalAmount } from '../../utils/decimal-amount.js';
import type { TokenPlanCoupon, TokenPlanQuote } from '../../types/tokenplan-purchase.js';

export const NO_TOKENPLAN_COUPON = 'youhuiquan_promotion_option_id_for_blank';

export function tokenPlanRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

export function tokenPlanProtocolError(): never {
  throw new CliError({
    code: 'TOKENPLAN_PROTOCOL_ERROR',
    message: 'Token Plan response is incomplete or conflicting; no purchase can be confirmed.',
    exitCode: 4,
  });
}

export function assertTokenPlanSuccess(raw: Record<string, unknown>): void {
  for (const field of ['successResponse', 'success', 'Success']) {
    if (Object.hasOwn(raw, field) && raw[field] !== true) tokenPlanProtocolError();
  }
  for (const field of ['code', 'Code']) {
    if (!Object.hasOwn(raw, field)) continue;
    const code = raw[field];
    if (typeof code !== 'string') tokenPlanProtocolError();
    if (!['200', 'Success', 'SUCCESS'].includes(code)) {
      throw new CliError({
        code: 'TOKENPLAN_BUSINESS_REJECTED',
        message: 'Token Plan request was rejected by the service.',
        exitCode: 1,
      });
    }
  }
}

export function parseTokenPlanCommodity(
  data: unknown,
  commodityCode: string,
): Record<string, unknown> {
  const raw = tokenPlanRecord(data);
  const view = tokenPlanRecord(raw?.viewModel);
  if (
    !raw ||
    raw.successResponse !== true ||
    view?.id !== commodityCode ||
    (view.commodityCode !== undefined && view.commodityCode !== commodityCode) ||
    !tokenPlanRecord(raw.components) ||
    !tokenPlanRecord(raw.componentsMeta)
  ) {
    return tokenPlanProtocolError();
  }
  assertTokenPlanSuccess(raw);
  return raw;
}

/**
 * Convert a minor-unit string to a major-unit amount by dividing by 100.
 * Return undefined for empty or invalid values; DecimalAmount performs validation.
 */
function fenToYuan(fen: string): string | undefined {
  if (!fen && fen !== '0') return undefined;
  try {
    const canonical = DecimalAmount.fromApi(fen).toCanonicalString();
    if (canonical === '0') return '0';
    const [intPart, fracPart = ''] = canonical.split('.');
    const combined = intPart + fracPart;
    const newFracLen = fracPart.length + 2;
    const padded = combined.padStart(newFracLen + 1, '0');
    const cut = padded.length - newFracLen;
    const yuanInt = padded.slice(0, cut).replace(/^0+/, '') || '0';
    const yuanFrac = padded.slice(cut).replace(/0+$/, '');
    return yuanFrac ? `${yuanInt}.${yuanFrac}` : yuanInt;
  } catch {
    return undefined;
  }
}

/** Format a millisecond timestamp as local time in `YYYY-MM-DD HH:mm:ss` form. */
function formatTimestamp(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function optionalTokenPlanAmount(value: unknown): DecimalAmount | null {
  if (value === undefined || value === null) return null;
  try {
    return DecimalAmount.fromApi(value);
  } catch {
    return null;
  }
}

function safeLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
  );
}

export function parseTokenPlanQuote(data: unknown, requestedCoupon: string): TokenPlanQuote {
  const raw = tokenPlanRecord(data);
  const price = tokenPlanRecord(raw?.price);
  const order = tokenPlanRecord(price?.order);
  if (!raw || !price || !order) return tokenPlanProtocolError();
  assertTokenPlanSuccess(raw);
  assertTokenPlanSuccess(price);
  assertTokenPlanSuccess(order);
  if (
    [raw.message, order.message].some(
      (message) => typeof message === 'string' && message.includes('已达上限'),
    )
  ) {
    throw new CliError({
      code: 'TOKENPLAN_ALREADY_SUBSCRIBED',
      message: 'An existing subscription prevents this purchase.',
      exitCode: 1,
    });
  }
  if (
    order.currency !== 'CNY' ||
    !tokenPlanRecord(order.orderLines) ||
    !Array.isArray(order.optionalPromotions)
  ) {
    return tokenPlanProtocolError();
  }
  for (const line of Object.values(order.orderLines as Record<string, unknown>)) {
    if (!tokenPlanRecord(line)) return tokenPlanProtocolError();
  }
  const tradeAmount = DecimalAmount.fromApi(order.tradeAmount);
  const coupons: TokenPlanCoupon[] = [];
  const selected: string[] = [];
  for (const value of order.optionalPromotions) {
    const promotion = tokenPlanRecord(value);
    if (!promotion) return tokenPlanProtocolError();
    if (promotion.optionCode !== 'youhui_quan') continue;
    // The blank "no coupon" sentinel is legitimately selected=true + effective=false;
    // only reject genuinely conflicting real-coupon entries.
    if (
      promotion.selected === true &&
      promotion.effective !== true &&
      promotion.promotionOptionNo !== NO_TOKENPLAN_COUPON
    )
      return tokenPlanProtocolError();
    if (promotion.effective !== true) continue;
    if (
      !safeLabel(promotion.promotionOptionNo) ||
      !safeLabel(promotion.promotionName) ||
      typeof promotion.selected !== 'boolean'
    )
      return tokenPlanProtocolError();
    const id = promotion.promotionOptionNo;
    if (coupons.some((coupon) => coupon.id === id)) return tokenPlanProtocolError();
    if (id !== NO_TOKENPLAN_COUPON) {
      const ext = tokenPlanRecord(promotion.activityExtInfo);
      coupons.push({
        id,
        name: promotion.promotionName,
        balance: ext?.availableAmount != null ? fenToYuan(String(ext.availableAmount)) : undefined,
        faceValue:
          ext?.couponTotalAmount != null ? fenToYuan(String(ext.couponTotalAmount)) : undefined,
        validUntil: ext?.endTimestamp
          ? formatTimestamp(Number(ext.endTimestamp))
          : ext?.endTime != null
            ? String(ext.endTime)
            : undefined,
        deductionAmount:
          promotion.canPromFee != null ? fenToYuan(String(promotion.canPromFee)) : undefined,
        recommended: promotion.selected === true && promotion.effective === true,
      });
    }
    if (promotion.selected) selected.push(id);
  }
  if (selected.length > 1) return tokenPlanProtocolError();
  const coupon = selected[0] ?? NO_TOKENPLAN_COUPON;
  if (requestedCoupon !== 'default' && requestedCoupon !== coupon) {
    if (
      requestedCoupon !== NO_TOKENPLAN_COUPON &&
      !coupons.some((candidate) => candidate.id === requestedCoupon)
    ) {
      throw new CliError({
        code: 'TOKENPLAN_COUPON_INVALID',
        message: 'The selected coupon is not available in this quote.',
        exitCode: 1,
      });
    }
    return tokenPlanProtocolError();
  }
  const zero = DecimalAmount.parse('0');
  const selectedCoupon =
    coupon === NO_TOKENPLAN_COUPON
      ? undefined
      : coupons.find((candidate) => candidate.id === coupon);
  if (coupon !== NO_TOKENPLAN_COUPON && selectedCoupon?.deductionAmount === undefined) {
    return tokenPlanProtocolError();
  }
  const couponDeduction =
    selectedCoupon?.deductionAmount === undefined
      ? zero
      : DecimalAmount.parse(selectedCoupon.deductionAmount);
  const planAmount = tradeAmount.add(couponDeduction);
  const originalAmount =
    optionalTokenPlanAmount(order.standPrice) ??
    optionalTokenPlanAmount(order.originalAmount) ??
    planAmount;
  if (originalAmount.compare(planAmount) < 0) return tokenPlanProtocolError();
  const promotionDeduction = originalAmount.subtract(planAmount);
  return {
    amount: tradeAmount.toCanonicalString(),
    tradeAmount: tradeAmount.toCanonicalString(),
    currency: 'CNY',
    coupon,
    coupons,
    originalAmount: originalAmount.toCanonicalString(),
    planAmount: planAmount.toCanonicalString(),
    promotionDeduction: promotionDeduction.toCanonicalString(),
    couponDeduction: couponDeduction.toCanonicalString(),
  };
}

export function parseTokenPlanInventory(data: unknown): boolean {
  const raw = tokenPlanRecord(data);
  if (!raw || typeof raw.available !== 'boolean') return tokenPlanProtocolError();
  assertTokenPlanSuccess(raw);
  return raw.available;
}
