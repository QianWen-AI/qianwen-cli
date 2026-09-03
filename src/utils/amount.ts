/** Exact decimal-string amount arithmetic (BigInt fixed-point). */

const PRECISION = 12;
const FACTOR_BIGINT = 10n ** BigInt(PRECISION);

/** Strictly parsed positive CNY amount used by the recharge flow. */
export interface ParsedRechargeAmount {
  cents: bigint;
  amount: string;
}

/**
 * Parse a positive CNY amount without ever routing through IEEE-754 arithmetic.
 *
 * @param value Raw CLI amount.
 * @returns Integer cents and the canonical two-decimal representation.
 * @throws Error when the value is not a positive decimal with at most two decimals.
 */
export function parseRechargeAmount(value: string): ParsedRechargeAmount {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('Amount must be a positive number with at most two decimal places.');
  }
  const [integer, fraction = ''] = value.split('.');
  const cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) throw new Error('Amount must be at least 0.01 CNY.');
  return { cents, amount: `${integer}.${fraction.padEnd(2, '0')}` };
}

/** Sum decimal-string amounts using BigInt fixed-point arithmetic. */
export function sumAmountStrings(values: string[]): string {
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

/**
 * Render a finite number as a plain decimal string (never exponential
 * notation). `String(1e-12)` yields "1e-12", which `sumAmountStrings` cannot
 * parse; expand such values via toFixed at the fixed-point precision and
 * strip the trailing zeros toFixed pads in.
 */
export function toDecimalString(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const s = String(value);
  if (!/e/i.test(s)) return s;
  return value.toFixed(PRECISION).replace(/0+$/, '').replace(/\.$/, '');
}

/** Subtract two decimal-string amounts (a - b) using BigInt fixed-point arithmetic. */
export function subtractAmountStrings(a: string, b: string): string {
  const negB = b.startsWith('-') ? b.slice(1) : `-${b}`;
  return sumAmountStrings([a, negB]);
}

/**
 * Sum numeric costs exactly by routing their shortest decimal representation
 * through `sumAmountStrings`. Avoids both float-accumulation drift (fake
 * digits like 0.30000000000000004) and any fixed-decimal rounding, so the
 * result carries every meaningful digit the upstream amounts had.
 */
export function sumCostsExact(values: number[]): number {
  return parseFloat(sumAmountStrings(values.map(toDecimalString)));
}
