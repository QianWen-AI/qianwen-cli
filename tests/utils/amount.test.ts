import { describe, it, expect } from 'vitest';
import { sumAmountStrings, sumCostsExact, toDecimalString } from '../../src/utils/amount.js';

describe('sumAmountStrings', () => {
  it('returns "0" for empty input', () => {
    expect(sumAmountStrings([])).toBe('0');
  });

  it('sums decimal strings exactly', () => {
    expect(sumAmountStrings(['0.1', '0.2'])).toBe('0.3');
  });

  it('normalizes trailing zeros away', () => {
    expect(sumAmountStrings(['1.500', '0.500'])).toBe('2');
  });

  it('keeps all twelve fixed-point fraction digits', () => {
    expect(sumAmountStrings(['0.000000000001', '0.000000000002'])).toBe('0.000000000003');
  });
});

describe('sumCostsExact', () => {
  it('avoids floating-point drift digits', () => {
    // Plain float addition yields 0.30000000000000004.
    expect(sumCostsExact([0.1, 0.2])).toBe(0.3);
  });

  it('preserves digits beyond four decimals', () => {
    expect(sumCostsExact([0.123456789012])).toBe(0.123456789012);
  });

  it('sums many small amounts without rounding', () => {
    expect(sumCostsExact([0.0001, 0.0002, 0.00005])).toBe(0.00035);
  });

  it('sums mixed-sign amounts exactly', () => {
    expect(sumCostsExact([-0.1, 0.2])).toBe(0.1);
  });

  it('returns 0 when the amount is below the twelve-digit fixed-point precision', () => {
    expect(sumCostsExact([1e-13])).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(sumCostsExact([])).toBe(0);
  });
});

describe('toDecimalString', () => {
  it('passes plain decimal representations through unchanged', () => {
    expect(toDecimalString(0.1235)).toBe('0.1235');
    expect(toDecimalString(3)).toBe('3');
  });

  it('expands exponential notation into plain decimals', () => {
    expect(toDecimalString(1e-12)).toBe('0.000000000001');
  });

  it('expands negative exponential notation without padded trailing zeros', () => {
    expect(toDecimalString(-1e-7)).toBe('-0.0000001');
  });

  it('falls back to "0" for non-finite values', () => {
    expect(toDecimalString(Number.NaN)).toBe('0');
    expect(toDecimalString(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
