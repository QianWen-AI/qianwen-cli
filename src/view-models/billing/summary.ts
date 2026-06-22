import type {
  ChargeType,
  SettleBillCycle,
  SettleBillSummary,
  SettleBillTotals,
} from '../../types/billing-extra.js';
import { CURRENCY_CODE, formatMoney, type ViewContext } from './shared.js';

export interface BillingSummaryFieldViewModel {
  label: string;
  value: string;
  raw: string;
}

export interface BillingSummaryCycleViewModel {
  billingCycle: string;
  aftertaxAmount: string;
  display: BillingSummaryFieldViewModel[];
}

export interface BillingSummaryTotalsViewModel {
  aftertaxAmount: string;
}

export interface BillingSummaryViewModel {
  cycle: string;
  chargeType: ChargeType | undefined;
  currency: string;
  cycles: BillingSummaryCycleViewModel[];
  totals: BillingSummaryTotalsViewModel;
  fields: BillingSummaryFieldViewModel[];
}

// High-precision string-amount summation (×10^12 integer math); avoids
// IEEE-754 drift. Inlined here because the BillingService layer arrives
// in a later task. Empty input → '0'.
const PRECISION = 12;
const FACTOR_BIGINT = 10n ** BigInt(PRECISION);

function sumAmountStrings(values: string[]): string {
  if (values.length === 0) return '0';

  let sum = 0n;
  for (const v of values) {
    const trimmed = v.trim();
    if (!trimmed || trimmed === '0') continue;

    const check = parseFloat(trimmed);
    if (!Number.isFinite(check)) continue;

    const isNegative = trimmed.startsWith('-');
    const absStr = isNegative ? trimmed.substring(1) : trimmed;
    const dotIdx = absStr.indexOf('.');

    let intPart: string;
    let fracPart: string;

    if (dotIdx !== -1) {
      intPart = absStr.substring(0, dotIdx) || '0';
      fracPart = absStr.substring(dotIdx + 1);
    } else {
      intPart = absStr;
      fracPart = '';
    }

    fracPart = fracPart.padEnd(PRECISION, '0').substring(0, PRECISION);

    const bigintVal = BigInt(intPart) * FACTOR_BIGINT + BigInt(fracPart);
    sum += isNegative ? -bigintVal : bigintVal;
  }

  if (sum === 0n) return '0';

  const isNeg = sum < 0n;
  const absSum = isNeg ? (-sum).toString() : sum.toString();

  const padded = absSum.padStart(PRECISION + 1, '0');
  const splitIdx = padded.length - PRECISION;
  const intResult = padded.substring(0, splitIdx).replace(/^0+/, '') || '0';
  const fracResult = padded.substring(splitIdx).replace(/0+$/, '');

  let result = intResult;
  if (fracResult) result += '.' + fracResult;
  if (isNeg && result !== '0') result = '-' + result;

  return result;
}

function sumField(
  cycles: SettleBillCycle[],
  pick: (c: SettleBillCycle) => string,
  fallback: string,
): string {
  if (cycles.length === 0) return fallback;
  const values = cycles.map(pick).filter((v) => v != null && v !== '');
  if (values.length === 0) return fallback;
  return sumAmountStrings(values);
}

function deriveTotals(data: SettleBillSummary): SettleBillTotals {
  if (data.totals) return data.totals;
  return {
    pretaxAmount: sumField(data.cycles, (c) => c.pretaxAmount, '0'),
    tax: sumField(data.cycles, (c) => c.tax, '0'),
    aftertaxAmount: sumField(data.cycles, (c) => c.aftertaxAmount, '0'),
  };
}

export function buildBillingSummaryViewModel(
  data: SettleBillSummary,
  ctx: ViewContext,
): BillingSummaryViewModel {
  const cycleLabel =
    data.period.from === data.period.to
      ? data.period.from
      : `${data.period.from} → ${data.period.to}`;
  const totals = deriveTotals(data);

  const fields: BillingSummaryFieldViewModel[] = [
    {
      label: 'Total',
      value: formatMoney(totals.aftertaxAmount, ctx),
      raw: totals.aftertaxAmount,
    },
  ];

  const cycles: BillingSummaryCycleViewModel[] = data.cycles.map((c) => ({
    billingCycle: c.billingCycle,
    aftertaxAmount: c.aftertaxAmount,
    display: [
      {
        label: 'Total',
        value: formatMoney(c.aftertaxAmount, ctx),
        raw: c.aftertaxAmount,
      },
    ],
  }));

  return {
    cycle: cycleLabel,
    chargeType: data.chargeType,
    currency: ctx.currency || CURRENCY_CODE,
    cycles,
    totals: {
      aftertaxAmount: totals.aftertaxAmount,
    },
    fields,
  };
}
