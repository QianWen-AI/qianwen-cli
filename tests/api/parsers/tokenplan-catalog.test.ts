/** Unit tests for parseTokenPlanCatalogQuota — personal quota-config parsing. */
import { describe, it, expect } from 'vitest';
import { parseTokenPlanCatalogQuota } from '../../../src/api/parsers/tokenplan-catalog.js';
import { GatewayShapeError } from '../../../src/api/request-adapter.js';

describe('parseTokenPlanCatalogQuota', () => {
  it('parses the production monthly-only shape and ignores the addon_quota key', () => {
    const result = parseTokenPlanCatalogQuota({
      data: {
        lite: { five_hour: 700, monthly: 11500 },
        essential: { five_hour: 1800, monthly: 25500 },
        standard: { five_hour: 3000, monthly: 45000 },
        pro: { five_hour: 12000, monthly: 180000 },
        addon_quota: { extrabundle: 20000 },
      },
    });

    expect(result).toEqual({
      lite: { weekly: null, monthly: 11500 },
      essential: { weekly: null, monthly: 25500 },
      standard: { weekly: null, monthly: 45000 },
      pro: { weekly: null, monthly: 180000 },
    });
    expect(result).not.toHaveProperty('addon_quota');
  });

  it('keeps weekly and monthly when both are reported', () => {
    const result = parseTokenPlanCatalogQuota({
      data: {
        lite: { weekly: 700, monthly: 11500 },
        essential: { weekly: 1800, monthly: 25500 },
        standard: { weekly: 3000, monthly: 45000 },
        pro: { weekly: 12000, monthly: 180000 },
      },
    });

    expect(result.lite).toEqual({ weekly: 700, monthly: 11500 });
    expect(result.pro).toEqual({ weekly: 12000, monthly: 180000 });
  });

  it('normalizes absent or invalid limits to null for every whitelisted tier', () => {
    const result = parseTokenPlanCatalogQuota({
      data: {
        lite: { monthly: 11500 },
        essential: { weekly: '1800', monthly: -1 },
        standard: { weekly: Number.NaN },
      },
    });

    expect(result).toEqual({
      lite: { weekly: null, monthly: 11500 },
      essential: { weekly: null, monthly: null },
      standard: { weekly: null, monthly: null },
      pro: { weekly: null, monthly: null },
    });
  });

  it('rejects a response whose data is not a plain object', () => {
    expect(() => parseTokenPlanCatalogQuota({ data: null })).toThrow(GatewayShapeError);
    expect(() => parseTokenPlanCatalogQuota({})).toThrow(GatewayShapeError);
  });
});
