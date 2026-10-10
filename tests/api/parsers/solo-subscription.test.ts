/** Unit tests for parseSoloSubscription. */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  parseSoloCatalogBillingCycle,
  parseSoloCatalogSubscription,
  parseSoloQuotaConfig,
  parseSoloSubscription,
  parseSoloUsage,
} from '../../../src/api/parsers/solo-subscription.js';
import { GatewayShapeError } from '../../../src/api/request-adapter.js';
import { unwrapCsDataResponse } from '../../../src/api/adapters/cs-data-adapter.js';

const NOW = Date.parse('2026-09-10T00:00:00Z');

function activeEntity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    instanceCode: 'sub-1',
    specCode: 'lite',
    remainingDays: 20,
    startTime: now - 3_600_000,
    endTime: now + 3_600_000 * 24 * 20,
    autoRenewFlag: false,
    status: 'VALID',
    ...overrides,
  };
}

describe('parseSoloCatalogSubscription', () => {
  it.each([undefined, null, {}, { status: 'EXPIRED' }, { status: 'INVALID' }])(
    'treats a non-VALID pricing-card state as not subscribed: %j',
    (data) => {
      const business = data === undefined ? {} : { data };
      expect(parseSoloCatalogSubscription(business)).toEqual({
        status: 'none',
        instanceCode: null,
        specCode: null,
      });
    },
  );

  it('accepts the minimal VALID identity used by the pricing card', () => {
    expect(
      parseSoloCatalogSubscription({
        data: { status: 'VALID', instanceCode: 'sub-1', specCode: 'essential' },
      }),
    ).toEqual({ status: 'active', instanceCode: 'sub-1', specCode: 'essential' });
  });

  it('rejects an incomplete VALID identity instead of guessing the current tier', () => {
    expect(() =>
      parseSoloCatalogSubscription({ data: { status: 'VALID', instanceCode: 'sub-1' } }),
    ).toThrow(GatewayShapeError);
  });
});

describe('parseSoloCatalogBillingCycle', () => {
  it('prefers the ord_time instance component', () => {
    expect(
      parseSoloCatalogBillingCycle({
        instanceComponents: [
          {
            componentCode: 'ord_time',
            instanceProperty: [{ code: 'ord_time', value: '3:Month' }],
          },
        ],
      }),
    ).toBe('quarterly');
  });

  it('reads the original cycle from serialized purchase params', () => {
    expect(
      parseSoloCatalogBillingCycle({
        purchaseParams: {
          orderTimeExpression: JSON.stringify({ originQuantity: 1, originCycleUnit: 1 }),
        },
      }),
    ).toBe('yearly');
  });

  it('uses diffMonth for an upgraded instance', () => {
    expect(
      parseSoloCatalogBillingCycle({
        purchaseParams: {
          tradeType: 'UPGRADE',
          orderTimeExpression: { diffMonth: 1, originQuantity: 1, originCycleUnit: 1 },
        },
      }),
    ).toBe('monthly');
  });

  it('returns null when the card cannot establish a supported cycle', () => {
    expect(
      parseSoloCatalogBillingCycle({
        purchaseParams: { orderTimeExpression: '{malformed' },
      }),
    ).toBeNull();
  });
});

describe('parseSoloSubscription', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns unknown when API reports data: null', () => {
    const result = parseSoloSubscription({ data: null });
    expect(result.status).toBe('unknown');
    expect(result.subscription).toBeNull();
    expect(result.reason).toBe('null_data');
  });

  it('returns none when the successful business envelope omits the data field', () => {
    const result = parseSoloSubscription({
      code: 'SUCCESS',
      success: true,
      msg: 'Success.',
      requestId: 'x',
    });
    expect(result.status).toBe('none');
    expect(result.subscription).toBeNull();
    expect(result.reason).toBe('no_subscription');
  });

  it('accepts the documented no-data shape after strict cs-data envelope validation', () => {
    const business = unwrapCsDataResponse({
      code: '200',
      successResponse: true,
      data: {
        success: true,
        DataV2: {
          ret: ['SUCCESS::ok'],
          data: { code: 'SUCCESS', success: true, requestId: 'synthetic-request' },
        },
      },
    });
    expect(parseSoloSubscription(business)).toEqual({
      status: 'none',
      subscription: null,
      reason: 'no_subscription',
    });
  });

  it.each([
    {},
    { data: undefined },
    { code: 'SUCCESS' },
    { success: true },
    { code: 'FAILED', success: true },
    { code: 'SUCCESS', success: false },
    { code: 'SUCCESS', success: 'true' },
    { code: '200', success: true },
    { code: 'SUCCESS', success: true, data: undefined },
  ])(
    'returns unknown when missing data does not establish a successful empty state: %j',
    (business) => {
      expect(parseSoloSubscription(business)).toEqual({
        status: 'unknown',
        subscription: null,
        reason: 'missing_data',
      });
    },
  );

  it.each([
    { data: null, reason: 'null_data' },
    { data: {}, reason: 'empty_data' },
  ])('does not extend the confirmed empty-state contract to $reason', ({ data, reason }) => {
    expect(parseSoloSubscription({ code: 'SUCCESS', success: true, data })).toEqual({
      status: 'unknown',
      subscription: null,
      reason,
    });
  });

  it('returns unknown when the INVALID subscription entity is incomplete', () => {
    const result = parseSoloSubscription({ data: { status: 'INVALID' } });
    expect(result.status).toBe('unknown');
    expect(result.subscription).toBeNull();
    expect(result.reason).toBe('unconfirmed_status');
  });

  it.each(['CANCELLED', 'UNKNOWN', 'EXPIRED', 'valid', 'invalid', ''])(
    'returns unknown for the non-VALID status %j',
    (status) => {
      expect(parseSoloSubscription({ data: { status } })).toEqual({
        status: 'unknown',
        subscription: null,
        reason: 'unconfirmed_status',
      });
    },
  );

  it.each([
    { period: 'expired', endTime: NOW - 1_000 },
    { period: 'ending now', endTime: NOW },
    { period: 'unexpired', endTime: NOW + 1_000 },
  ])('keeps a complete $period INVALID entity unknown without purchase gates', ({ endTime }) => {
    const result = parseSoloSubscription({
      data: activeEntity({
        status: 'INVALID',
        remainingDays: 0,
        startTime: NOW - 2_000,
        endTime,
        commodityCode: 'sfm_tokenplansolo_public_cn',
      }),
    });

    expect(result).toEqual({
      status: 'unknown',
      subscription: null,
      reason: 'unconfirmed_status',
    });
  });

  it('returns unknown for an empty data object', () => {
    const result = parseSoloSubscription({ data: {} });
    expect(result.status).toBe('unknown');
    expect(result.subscription).toBeNull();
    expect(result.reason).toBe('empty_data');
  });

  it.each(['lite', 'essential', 'pro'])(
    'returns active for a well-formed VALID %s subscription',
    (specCode) => {
      const entity = activeEntity({ specCode });
      expect(parseSoloSubscription({ data: entity })).toEqual({
        status: 'active',
        subscription: entity,
      });
    },
  );

  it('accepts a VALID subscription starting now with the matching commodity', () => {
    const result = parseSoloSubscription({
      data: activeEntity({
        startTime: NOW,
        commodityCode: 'sfm_tokenplansolo_public_cn',
        autoRenewFlag: true,
      }),
    });

    expect(result.status).toBe('active');
    expect(result.subscription?.autoRenewFlag).toBe(true);
  });

  it.each([
    { startTime: NOW + 1_000, endTime: NOW + 2_000 },
    { startTime: NOW - 2_000, endTime: NOW - 1_000 },
    { startTime: NOW - 2_000, endTime: NOW },
  ])('returns unknown when the active period has not started or already ended: %j', (period) => {
    const result = parseSoloSubscription({ data: activeEntity(period) });
    expect(result.status).toBe('unknown');
    expect(result.subscription).toBeNull();
    expect(result.reason).toBe('inconsistent_period');
  });

  it('throws GatewayShapeError when status field is missing on a non-null entity', () => {
    expect(() => parseSoloSubscription({ data: { instanceCode: 'x' } })).toThrow(GatewayShapeError);
  });

  it.each([undefined, null, true, 123, {}])('rejects a non-string status: %j', (status) => {
    expect(() => parseSoloSubscription({ data: { status } })).toThrow(GatewayShapeError);
  });

  it.each([null, undefined, [], 'invalid', false])(
    'rejects a malformed envelope: %j',
    (business) => {
      expect(() => parseSoloSubscription(business)).toThrow(GatewayShapeError);
    },
  );

  it.each([[], 'invalid', false, 123])('rejects malformed non-null data: %j', (data) => {
    expect(() => parseSoloSubscription({ data })).toThrow(GatewayShapeError);
  });

  it.each([
    { instanceCode: undefined },
    { instanceCode: ' ' },
    { specCode: 'unknown' },
    { remainingDays: -1 },
    { remainingDays: Number.NaN },
    { remainingDays: Number.POSITIVE_INFINITY },
    { startTime: '2026-09-01T00:00:00Z' },
    { startTime: -1 },
    { endTime: NOW + 0.5 },
    { endTime: 8_640_000_000_000_001 },
    { startTime: NOW, endTime: NOW },
    { startTime: NOW, endTime: NOW - 1 },
    { autoRenewFlag: undefined },
    { autoRenewFlag: 'false' },
    { commodityCode: 'sfm_tokenplanteams_dp_cn' },
  ])('preserves strict VALID field validation: %j', (overrides) => {
    expect(() => parseSoloSubscription({ data: activeEntity(overrides) })).toThrow(
      GatewayShapeError,
    );
  });
});

describe('parseSoloUsage', () => {
  it('parses the monthly production contract observed on 2026-09-23', () => {
    expect(
      parseSoloUsage({
        code: 'SUCCESS',
        success: true,
        data: {
          per1MonthPercentage: 0.14380236521739131,
          per1MonthResetTime: NOW + 86_400_000,
        },
      }),
    ).toEqual({
      cycle: 'monthly',
      usedRatio: 0.14380236521739131,
      resetTime: NOW + 86_400_000,
    });
  });

  it.each([0, 1])('accepts monthly boundary ratios: %p', (percentage) => {
    expect(parseSoloUsage({ data: { per1MonthPercentage: percentage } })).toEqual({
      cycle: 'monthly',
      usedRatio: percentage,
    });
  });

  it('prefers the monthly window when both cycle fields are present', () => {
    expect(
      parseSoloUsage({
        data: {
          per1MonthPercentage: 0.5,
          per1MonthResetTime: NOW + 86_400_000,
          per1WeekPercentage: 0.25,
          per1WeekResetTime: NOW,
        },
      }),
    ).toEqual({ cycle: 'monthly', usedRatio: 0.5, resetTime: NOW + 86_400_000 });
  });

  it.each([
    { per1MonthPercentage: null, per1MonthResetTime: NOW },
    { per1MonthPercentage: -0.01, per1MonthResetTime: NOW },
    { per1MonthPercentage: 1.01, per1MonthResetTime: NOW },
    { per1MonthPercentage: Number.NaN, per1MonthResetTime: NOW },
    { per1MonthPercentage: '0.5', per1MonthResetTime: NOW },
    { per1MonthPercentage: 0.5, per1MonthResetTime: NOW + 0.5 },
    { per1MonthPercentage: 0.5, per1MonthResetTime: 'tomorrow' },
  ])('rejects malformed monthly usage data: %j', (data) => {
    expect(() => parseSoloUsage({ data })).toThrow(GatewayShapeError);
  });

  it('keeps the legacy seven-day window as an explicit weekly cycle', () => {
    expect(
      parseSoloUsage({
        code: 'SUCCESS',
        success: true,
        data: {
          per1WeekPercentage: 0.375,
          per1WeekResetTime: NOW + 86_400_000,
        },
      }),
    ).toEqual({
      cycle: 'weekly',
      usedRatio: 0.375,
      resetTime: NOW + 86_400_000,
    });
  });

  it('accepts a legacy weekly percentage without a reset time', () => {
    expect(parseSoloUsage({ data: { per1WeekPercentage: 0 } })).toEqual({
      cycle: 'weekly',
      usedRatio: 0,
    });
  });

  it.each([
    { code: 'SUCCESS', success: true },
    { data: null },
    { data: {} },
    { data: { futureUsageWindow: null } },
    { data: { per1WeekResetTime: NOW } },
    { data: { per1MonthResetTime: NOW } },
  ])('treats an absent usage window as optional: %j', (business) => {
    expect(parseSoloUsage(business)).toBeNull();
  });

  it.each([
    { per1WeekPercentage: null, per1WeekResetTime: NOW },
    { per1WeekPercentage: -0.01, per1WeekResetTime: NOW },
    { per1WeekPercentage: 1.01, per1WeekResetTime: NOW },
    { per1WeekPercentage: Number.NaN, per1WeekResetTime: NOW },
    { per1WeekPercentage: 0.5, per1WeekResetTime: NOW + 0.5 },
    { per1WeekPercentage: 0.5, per1WeekResetTime: 'tomorrow' },
  ])('rejects malformed usage data: %j', (data) => {
    expect(() => parseSoloUsage({ data })).toThrow(GatewayShapeError);
  });
});

describe('parseSoloQuotaConfig', () => {
  it('accepts weekly limits without the retired five-hour field', () => {
    expect(
      parseSoloQuotaConfig({
        data: {
          lite: { weekly: 100 },
          essential: { weekly: 150 },
          standard: { weekly: 200 },
          pro: { weekly: 300 },
        },
      }),
    ).toEqual({
      lite: { weekly: 100 },
      essential: { weekly: 150 },
      standard: { weekly: 200 },
      pro: { weekly: 300 },
    });
  });

  it('still rejects an invalid weekly limit', () => {
    expect(() =>
      parseSoloQuotaConfig({
        data: {
          lite: { weekly: '100' },
          standard: { weekly: 200 },
          pro: { weekly: 300 },
        },
      }),
    ).toThrow(GatewayShapeError);
  });

  it('accepts a monthly-only tier and omits the absent weekly field', () => {
    expect(
      parseSoloQuotaConfig({
        data: {
          lite: { monthly: 11500 },
          essential: { monthly: 25500 },
          standard: { monthly: 45000 },
          pro: { monthly: 180000 },
        },
      }),
    ).toEqual({
      lite: { monthly: 11500 },
      essential: { monthly: 25500 },
      standard: { monthly: 45000 },
      pro: { monthly: 180000 },
    });
  });

  it('keeps both limits when weekly and monthly coexist', () => {
    expect(
      parseSoloQuotaConfig({
        data: {
          lite: { weekly: 700, monthly: 11500 },
          essential: { weekly: 1800, monthly: 25500 },
          standard: { weekly: 3000, monthly: 45000 },
          pro: { weekly: 12000, monthly: 180000 },
        },
      }),
    ).toEqual({
      lite: { weekly: 700, monthly: 11500 },
      essential: { weekly: 1800, monthly: 25500 },
      standard: { weekly: 3000, monthly: 45000 },
      pro: { weekly: 12000, monthly: 180000 },
    });
  });

  it('ignores non-tier keys such as addon_quota', () => {
    const result = parseSoloQuotaConfig({
      data: {
        lite: { monthly: 11500 },
        essential: { monthly: 25500 },
        standard: { monthly: 45000 },
        pro: { monthly: 180000 },
        addon_quota: { extrabundle: 20000 },
      },
    });
    expect(result).not.toHaveProperty('addon_quota');
    expect(Object.keys(result).sort()).toEqual(['essential', 'lite', 'pro', 'standard']);
  });

  it('rejects a tier carrying neither a valid weekly nor a valid monthly limit', () => {
    expect(() =>
      parseSoloQuotaConfig({
        data: {
          lite: { monthly: '11500' },
          essential: { monthly: 25500 },
          standard: { monthly: 45000 },
          pro: { monthly: 180000 },
        },
      }),
    ).toThrow(GatewayShapeError);
  });
});
