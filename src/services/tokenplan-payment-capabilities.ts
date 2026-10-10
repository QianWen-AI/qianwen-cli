import { isDeepStrictEqual } from 'node:util';
import { CliError } from '../utils/errors.js';
import { DecimalAmount } from '../utils/decimal-amount.js';
import { PAYMENT_CHANNELS, DEFAULT_CHANNEL } from '../config/payment-channels.js';
import type {
  CashPaymentCapabilities,
  CashFundingPlan,
  TokenPlanSettlementInfo,
} from '../types/tokenplan-payment.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolError(): CliError {
  return new CliError({
    code: 'TOKENPLAN_FUNDING_PROTOCOL',
    message: 'The Token Plan payment response could not be verified.',
    exitCode: 4,
  });
}

function aliases<Value>(
  record: Record<string, unknown>,
  keys: readonly string[],
  parse: (value: unknown) => Value,
): Value | undefined {
  const values = keys.filter((key) => Object.hasOwn(record, key)).map((key) => parse(record[key]));
  if (values.some((value) => !isDeepStrictEqual(value, values[0]))) throw protocolError();
  return values[0];
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\s\p{Cc}]/u.test(value)) throw protocolError();
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw protocolError();
  return Array.from(value, (entry: unknown) => {
    if (!isRecord(entry)) throw protocolError();
    return entry;
  });
}

function successfulPayload<Value>(
  raw: unknown,
  payloadKeys: readonly string[],
  parse: (record: Record<string, unknown>) => Value,
  successMarker: 'required' | 'optional' = 'required',
): Value {
  if (!isRecord(raw)) throw protocolError();
  const payloads = ['Data', 'data']
    .filter((key) => Object.hasOwn(raw, key))
    .map((key) => {
      const payload = raw[key];
      if (!isRecord(payload)) throw protocolError();
      return payload;
    });
  let confirmed = false;
  for (const record of [raw, ...payloads]) {
    const code = aliases(record, ['Code', 'code'], text);
    const success = aliases(record, ['Success', 'success', 'successResponse'], (value) => {
      if (value !== true) throw protocolError();
      return value;
    });
    if (code !== undefined && code !== 'Success' && code !== '200') throw protocolError();
    confirmed ||= code !== undefined || success === true;
  }
  if (!confirmed && successMarker === 'required') throw protocolError();
  if (payloads.length === 0 || payloadKeys.some((key) => Object.hasOwn(raw, key))) {
    payloads.push(raw);
  }
  const values = payloads.map(parse);
  if (values.some((value) => !isDeepStrictEqual(value, values[0]))) throw protocolError();
  return values[0];
}

const ZERO = DecimalAmount.parse('0');

// ---------------------------------------------------------------------------
// parsePaymentMethods
// ---------------------------------------------------------------------------

export interface ParsedPaymentMethods {
  cashMethods: Array<{ bookNo: string; available: string; currency: string }>;
  creditMethods: Array<{ bookNo: string; paymentType: string }>;
  hasPcChargePG: boolean;
}

export function parsePaymentMethods(raw: unknown): ParsedPaymentMethods | null {
  const innerKeys = ['InnerPaymentMethodList', 'innerPaymentMethodList'];
  const bizKeys = ['BizPaymentMethodList', 'bizPaymentMethodList'];
  const signedKeys = ['SignedPaymentMethodList', 'signedPaymentMethodList'];
  try {
    return successfulPayload(
      raw,
      [...innerKeys, ...bizKeys, ...signedKeys],
      (payload) => {
        const inner = aliases(payload, innerKeys, (value) => {
          const methods = records(value).map((item) => {
            const paymentType = aliases(
              item,
              ['PaymentType', 'PaymentMethodType', 'paymentType', 'paymentMethodType'],
              text,
            );
            if (paymentType === undefined) throw protocolError();
            return { item, paymentType };
          });
          const creditMethods = methods
            .filter(
              ({ paymentType }) =>
                paymentType === 'QUOTA_BOOK' || paymentType === 'LEGACY_CREDIT_ACCT_BOOK',
            )
            .map(({ paymentType }) => ({ bookNo: '', paymentType }));
          if (creditMethods.length > 0) {
            return { cashMethods: [], creditMethods };
          }

          const cashMethods: ParsedPaymentMethods['cashMethods'] = [];
          for (const { item, paymentType } of methods) {
            if (paymentType === 'STORED_VALUE_CARD') continue;
            if (paymentType !== 'LEGACY_ACCT_BOOK') throw protocolError();
            const available = aliases(
              item,
              ['PaymentMethodAvailableAmount', 'paymentMethodAvailableAmount'],
              (value) => DecimalAmount.fromApi(value).toCanonicalString(),
            );
            const currency = aliases(item, ['Currency', 'currency'], text);
            const bookNo = aliases(item, ['BookNo', 'bookNo'], text) ?? '';
            if (available === undefined || currency !== 'CNY') throw protocolError();
            const cash = { bookNo, available, currency };
            if (cashMethods.length > 0 && !isDeepStrictEqual(cashMethods[0], cash))
              throw protocolError();
            if (cashMethods.length === 0) cashMethods.push(cash);
          }

          return { cashMethods, creditMethods };
        });
        if (inner === undefined) throw protocolError();
        const { cashMethods, creditMethods } = inner;
        if (creditMethods.length > 0) return { cashMethods, creditMethods, hasPcChargePG: false };
        const biz = aliases(payload, bizKeys, records);
        if (biz === undefined) throw protocolError();
        aliases(payload, signedKeys, records);
        let hasPcChargePG = false;
        for (const item of biz) {
          const configs = aliases(
            item,
            ['PaymentTypeConfigList', 'paymentTypeConfigList'],
            records,
          );
          if (configs === undefined) throw protocolError();
          for (const config of configs) {
            const paymentType = aliases(config, ['PaymentType', 'paymentType'], text);
            if (paymentType === undefined) throw protocolError();
            hasPcChargePG ||= paymentType === PAYMENT_CHANNELS[DEFAULT_CHANNEL].capabilityKey;
          }
        }
        return { cashMethods, creditMethods, hasPcChargePG };
      },
      'optional',
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildCapabilities
// ---------------------------------------------------------------------------

export function buildCapabilities(
  identity: { site: string; nbid: string },
  methods: ReturnType<typeof parsePaymentMethods>,
): CashPaymentCapabilities {
  const base: Pick<CashPaymentCapabilities, 'identityContext'> = {
    identityContext: { site: identity.site, nbid: identity.nbid },
  };

  if (methods === null) {
    return {
      ...base,
      admissionResult: 'unknown',
      cashMethod: null,
      alipayScanning: false,
    };
  }

  if (methods.creditMethods.length > 0) {
    const types = methods.creditMethods.map((c) => c.paymentType).join(', ');
    return {
      ...base,
      admissionResult: 'unsupported',
      cashMethod: null,
      alipayScanning: false,
      unsupportedReason: `Credit-based Account: ${types}`,
    };
  }

  if (methods.cashMethods.length === 0) {
    return {
      ...base,
      admissionResult: 'supported',
      cashMethod: null,
      alipayScanning: methods.hasPcChargePG,
    };
  }

  const first = methods.cashMethods[0];
  try {
    const available = DecimalAmount.fromApi(first.available).toCanonicalString();
    if (
      methods.cashMethods.some(
        (method) =>
          method.bookNo !== first.bookNo ||
          method.currency !== 'CNY' ||
          DecimalAmount.fromApi(method.available).toCanonicalString() !== available,
      )
    )
      throw protocolError();
    return {
      ...base,
      admissionResult: 'supported',
      cashMethod: { available, currency: 'CNY' },
      alipayScanning: methods.hasPcChargePG,
    };
  } catch {
    return {
      ...base,
      admissionResult: 'unknown',
      cashMethod: null,
      alipayScanning: false,
    };
  }
}

// ---------------------------------------------------------------------------
// resolveDeductionIntent
// ---------------------------------------------------------------------------

export function resolveDeductionIntent(
  balanceDeduction: string | null,
): 'auto' | 'manual' | 'none' {
  if (balanceDeduction === null) return 'auto';

  const amount = DecimalAmount.parse(balanceDeduction);
  if (amount.compare(ZERO) === 0) return 'none';

  return 'manual';
}

// ---------------------------------------------------------------------------
// computeFundingPlan
// ---------------------------------------------------------------------------

export function computeFundingPlan(
  capabilities: CashPaymentCapabilities,
  intent: 'auto' | 'manual' | 'none',
  orderPayable: string,
  manualAmount?: string,
): CashFundingPlan {
  if (capabilities.admissionResult !== 'supported') {
    throw new CliError({
      code:
        capabilities.admissionResult === 'unsupported'
          ? 'TOKENPLAN_PAYMENT_UNSUPPORTED'
          : 'TOKENPLAN_PAYMENT_CAPABILITY_UNKNOWN',
      message: 'Payment capabilities could not be verified. Payment was not started.',
      exitCode: 4,
    });
  }

  const orderAmt = DecimalAmount.parse(orderPayable);
  if (capabilities.cashMethod !== null && capabilities.cashMethod.currency !== 'CNY')
    throw protocolError();
  const cashAvailable =
    capabilities.cashMethod === null
      ? ZERO
      : DecimalAmount.fromApi(capabilities.cashMethod.available);
  const maxAllowed = cashAvailable.min(orderAmt);
  let cashDeduction: DecimalAmount;

  if (intent === 'none') {
    cashDeduction = ZERO;
  } else if (intent === 'auto') {
    cashDeduction = maxAllowed.roundToCents();
  } else {
    if (manualAmount === undefined) {
      throw new CliError({
        code: 'TOKENPLAN_INVALID_DEDUCTION',
        message: 'A balance deduction amount is required.',
        exitCode: 4,
      });
    }
    const manual = DecimalAmount.parse(manualAmount);
    if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(manualAmount)) {
      throw new CliError({
        code: 'TOKENPLAN_INVALID_DEDUCTION',
        message: 'Balance deduction must use no more than two decimal places.',
        exitCode: 4,
      });
    }
    if (manual.compare(maxAllowed) > 0) {
      throw new CliError({
        code: 'TOKENPLAN_BALANCE_EXCEEDED',
        message: `Balance deduction ${manualAmount} exceeds the available maximum ${maxAllowed.toCanonicalString()}.`,
        exitCode: 4,
      });
    }
    cashDeduction = manual.roundToCents();
  }

  if (cashDeduction.compare(maxAllowed) > 0) {
    throw new CliError({
      code: 'TOKENPLAN_DEDUCTION_BOUNDARY',
      message: 'The balance deduction could not be verified against the order total.',
      exitCode: 4,
    });
  }
  const external = orderAmt.subtract(cashDeduction).roundToCents();

  return {
    paymentMode: 'cash_alipay',
    deductionIntent: intent,
    orderPayable: orderAmt.toCanonicalString(),
    cashDeduction: cashDeduction.toCanonicalString(),
    externalPayable: external.toCanonicalString(),
  };
}

// ---------------------------------------------------------------------------
// fundingPlanFingerprint
// ---------------------------------------------------------------------------

export function fundingPlanFingerprint(plan: CashFundingPlan): string {
  return JSON.stringify([
    plan.paymentMode,
    plan.deductionIntent,
    plan.cashDeduction,
    plan.externalPayable,
  ]);
}

// ---------------------------------------------------------------------------
// parseOrderSettlement
// ---------------------------------------------------------------------------

export function parseOrderSettlement(
  raw: unknown,
  expectedOrderId: string,
  expectedOrderIds: readonly string[] = [expectedOrderId],
): TokenPlanSettlementInfo {
  const settleKeys = [
    'SettleTotalPayFee',
    'settleTotalPayFee',
    'settle_total_pay_fee',
    'SettleTotalPayAmount',
    'settleTotalPayAmount',
    'settle_total_pay_amount',
    'RealSettleTotalPayAmount',
    'realSettleTotalPayAmount',
    'PayAmount',
    'TradeAmount',
  ] as const;
  const currencyKeys = [
    'SettleCurrency',
    'settleCurrency',
    'settle_currency',
    'realSettleCurrency',
    'SettCurrency',
    'Currency',
    'currency',
  ];
  const orderKeys = ['OrderId', 'orderId'];
  const orderIdsKeys = ['OrderIds', 'orderIds'];
  const lineKeys = ['OrderLines', 'orderLines', 'orderLineList', 'firstOrderLine'];
  const parseId = (value: unknown): string => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
    throw protocolError();
  };
  const parseIds = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length === 0) throw protocolError();
    const ids = Array.from(value, parseId);
    if (new Set(ids).size !== ids.length) throw protocolError();
    return ids.sort();
  };
  const readAmount = (record: Record<string, unknown>) =>
    aliases(record, settleKeys, (value) => DecimalAmount.fromApi(value).toCanonicalString());
  const readCurrency = (record: Record<string, unknown>) =>
    aliases(record, currencyKeys, (value) => {
      if (value !== 'CNY') {
        throw new CliError({
          code: 'TOKENPLAN_SETTLEMENT_CURRENCY',
          message:
            'The order currency could not be verified. Token Plan payment supports CNY only.',
          exitCode: 1,
        });
      }
      return value;
    });

  try {
    const primaryId = parseId(expectedOrderId);
    const expectedIds = parseIds(expectedOrderIds);
    if (!expectedIds.includes(primaryId)) throw protocolError();
    const result = successfulPayload(
      raw,
      [...settleKeys, ...currencyKeys, ...orderKeys, ...orderIdsKeys, ...lineKeys],
      (data) => {
        const orderId = aliases(data, orderKeys, parseId);
        if (orderId !== undefined && orderId !== primaryId) {
          throw new CliError({
            code: 'TOKENPLAN_SETTLEMENT_MISMATCH',
            message: 'The order identifier could not be verified. Payment was stopped.',
            exitCode: 1,
          });
        }
        const declaredIds = aliases(data, orderIdsKeys, parseIds);
        if (declaredIds !== undefined && !isDeepStrictEqual(declaredIds, expectedIds))
          throw protocolError();
        const currency = readCurrency(data);
        const amount = readAmount(data);
        const parseLine = (line: Record<string, unknown>) => {
          const lineAmount = readAmount(line);
          const lineCurrency = readCurrency(line) ?? currency;
          const lineOrderId =
            aliases(line, orderKeys, parseId) ?? (expectedIds.length === 1 ? orderId : undefined);
          if (lineAmount === undefined || lineCurrency === undefined) throw protocolError();
          if (lineOrderId !== undefined && !expectedIds.includes(lineOrderId))
            throw protocolError();
          return { amount: lineAmount, currency: lineCurrency, orderId: lineOrderId };
        };
        const sortedLines = (lines: Record<string, unknown>[]) =>
          lines
            .map(parseLine)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        const mappedLines = aliases(data, ['OrderLines', 'orderLines'], (value) => {
          if (!Array.isArray(value) && !isRecord(value)) throw protocolError();
          return sortedLines(records(Array.isArray(value) ? value : Object.values(value)));
        });
        const listedLines = aliases(data, ['orderLineList'], (value) =>
          sortedLines(records(value)),
        );
        if (
          mappedLines !== undefined &&
          listedLines !== undefined &&
          !isDeepStrictEqual(mappedLines, listedLines)
        )
          throw protocolError();
        const firstLine = aliases(data, ['firstOrderLine'], (value) => {
          if (!isRecord(value)) throw protocolError();
          return parseLine(value);
        });
        const completeLines = mappedLines ?? listedLines;
        if (completeLines !== undefined && completeLines.length === 0) throw protocolError();
        if (
          completeLines !== undefined &&
          firstLine !== undefined &&
          !completeLines.some((line) => isDeepStrictEqual(line, firstLine))
        )
          throw protocolError();
        if (completeLines === undefined && firstLine !== undefined && expectedIds.length > 1)
          throw protocolError();
        const lines = completeLines ?? (firstLine === undefined ? undefined : [firstLine]);
        const lineIds = lines?.map((line) => line.orderId);
        const coveredByLines =
          lineIds !== undefined &&
          lineIds.every((identifier) => identifier !== undefined) &&
          isDeepStrictEqual([...new Set(lineIds)].sort(), expectedIds);
        if (lineIds?.some((identifier) => identifier !== undefined) && !coveredByLines)
          throw protocolError();
        if (
          !coveredByLines &&
          declaredIds === undefined &&
          !(expectedIds.length === 1 && orderId === primaryId)
        )
          throw protocolError();

        const lineAmount = lines?.reduce(
          (sum, line) => sum.add(DecimalAmount.parse(line.amount)),
          ZERO,
        );
        if (
          amount !== undefined &&
          lineAmount !== undefined &&
          DecimalAmount.parse(amount).compare(lineAmount) !== 0
        )
          throw protocolError();
        const settledAmount =
          lineAmount ?? (amount === undefined ? undefined : DecimalAmount.parse(amount));
        if (settledAmount === undefined || (currency === undefined && lines === undefined))
          throw protocolError();
        return {
          settledPayable: settledAmount.toCanonicalString(),
          orderId: primaryId,
          currency: 'CNY' as const,
        };
      },
      'optional',
    );
    return result;
  } catch (error) {
    if (error instanceof CliError && error.code.startsWith('TOKENPLAN_SETTLEMENT_')) throw error;
    throw new CliError({
      code: 'TOKENPLAN_SETTLEMENT_PARSE',
      message: 'The order settlement response could not be verified. Payment was stopped.',
      exitCode: 4,
    });
  }
}
