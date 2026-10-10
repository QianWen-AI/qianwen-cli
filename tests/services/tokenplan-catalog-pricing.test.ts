/**
 * Unit tests for TokenPlanCatalogPricing.getPrice action selection.
 * Every tier of both editions uses QueryOrderLight, with the current catalog amount
 * read from articleItemResults[].price.discountedTotalPrice.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TokenPlanCatalogPricing,
  buildTokenPlanCatalogConfiguration,
} from '../../src/services/tokenplan-catalog-pricing.js';
import type { ApiClient, CallOrchestrationApiOptions } from '../../src/api/api-client.js';
import type { TokenPlanEdition } from '../../src/types/tokenplan-subscription.js';
import { site } from '../../src/site.js';

function commodity(edition: TokenPlanEdition, specCode: string, creditValue = '37500') {
  const individual = edition === 'individual';
  const commodityCode = individual
    ? site.features.tokenPlanCommodityCodes.soloBuy
    : site.features.tokenPlanCommodityCodes.teams;
  const tierKey = individual ? 'subscription_type' : 'plan_type';
  return {
    successResponse: true,
    viewModel: { id: commodityCode, name: 'Catalog product' },
    componentsMeta: {
      [individual ? 'subscription_type' : 'subscription_spec']: { name: 'Catalog tier' },
      ord_time: { name: 'Billing cycle' },
    },
    components: {
      [tierKey]: { [tierKey]: [{ value: specCode, text: 'Catalog tier name' }] },
      credit_value: { credit_value: [{ value: creditValue, text: 'Catalog Credits' }] },
      ord_time: { ord_time: [{ value: '1:Month', text: 'Monthly' }] },
    },
    constraint: { credit_value: { plan_type: { [specCode]: [creditValue] } } },
  };
}

function makeClient(handler: (opts: CallOrchestrationApiOptions<unknown>) => unknown): {
  apiClient: ApiClient;
  calls: CallOrchestrationApiOptions<unknown>[];
} {
  const calls: CallOrchestrationApiOptions<unknown>[] = [];
  const callOrchestrationApi = vi.fn((opts: CallOrchestrationApiOptions<unknown>) => {
    calls.push(opts);
    return Promise.resolve().then(() => handler(opts));
  });
  const apiClient = {
    callOrchestrationApi,
    callFlatApi: vi.fn(),
    callEnvelopeApi: vi.fn(),
    callCsDataApi: vi.fn(),
  } as unknown as ApiClient;
  return { apiClient, calls };
}

function lightResponse(
  edition: TokenPlanEdition,
  specCode: string,
  discountedTotalPrice: number,
): unknown {
  const tierKey = edition === 'individual' ? 'subscription_type' : 'plan_type';
  return {
    code: '200',
    price: {
      articleItemResults: [
        {
          articleItemName: 'Token Plan',
          price: { discountedTotalPrice },
          moduleResults: [{ moduleAttributeMap: { [tierKey]: specCode } }],
        },
      ],
    },
  };
}

function config(edition: TokenPlanEdition, specCode: string): Record<string, unknown> {
  return buildTokenPlanCatalogConfiguration(
    edition,
    specCode,
    'monthly',
    commodity(edition, specCode),
  );
}

describe('TokenPlanCatalogPricing.getCommodity', () => {
  it.each(['individual', 'team'] as const)(
    'loads %s metadata anonymously from the public route',
    async (edition) => {
      const data = commodity(edition, 'standard');
      const { apiClient, calls } = makeClient((opts) => opts.parse(data));
      const signal = new AbortController().signal;

      await expect(
        new TokenPlanCatalogPricing(apiClient).getCommodity(edition, signal),
      ).resolves.toBe(data);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        action: 'GetCommodity',
        path: '/data/publicCustom.json',
        authMode: 'none',
        params: { commodityCode: data.viewModel.id, orderType: 'BUY' },
        signal,
      });
    },
  );

  it.each(['before', 'during'] as const)(
    'honors cancellation %s the metadata request',
    async (timing) => {
      const controller = new AbortController();
      const { apiClient, calls } = makeClient((opts) => {
        controller.abort();
        return opts.parse(commodity('team', 'standard'));
      });
      if (timing === 'before') controller.abort();

      await expect(
        new TokenPlanCatalogPricing(apiClient).getCommodity('team', controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(timing === 'before' ? 0 : 1);
    },
  );
});

describe('buildTokenPlanCatalogConfiguration', () => {
  it('uses metadata names and Credits while retaining a single-seat coupon-free quote', () => {
    const configuration = config('team', 'standard');
    expect(configuration).toMatchObject({
      commodityName: 'Catalog product',
      quantity: 1,
      autoRenew: false,
      orderParams: {},
      config: {},
      couponForSpecItem: false,
      couponNum: '',
      components: expect.arrayContaining([
        expect.objectContaining({
          componentCode: 'subscription_spec',
          instanceProperty: expect.arrayContaining([
            { code: 'plan_type', value: 'standard', name: 'Catalog tier name' },
            { code: 'credit_value', value: '37500', name: 'Catalog Credits' },
            { code: 'seat_num', value: '1' },
          ]),
        }),
      ]),
    });
  });

  it('rejects missing commodity data instead of constructing a fallback', () => {
    expect(() => buildTokenPlanCatalogConfiguration('team', 'standard', 'monthly', {})).toThrow();
  });
});

describe('TokenPlanCatalogPricing.getPrice', () => {
  it.each([
    ['individual', 'essential', 15000, '150'],
    ['team', 'standard', 15000, '150'],
  ] as const)(
    'prices %s via public QueryOrderLight reading price.discountedTotalPrice',
    async (edition, specCode, discountedTotalPrice, expected) => {
      const { apiClient, calls } = makeClient((opts) =>
        opts.parse(lightResponse(edition, specCode, discountedTotalPrice)),
      );
      const pricing = new TokenPlanCatalogPricing(apiClient);

      const result = await pricing.getPrice(config(edition, specCode), {
        edition,
        specCode,
        authenticated: false,
      });

      expect(result.price).toBe(expected);
      expect(calls).toHaveLength(1);
      expect(calls[0].action).toBe('QueryOrderLight');
      expect(calls[0].path).toBe('/data/publicCustom.json');
      expect(calls[0].authMode).toBe('none');
    },
  );

  it('attaches the token opportunistically when authenticated (authMode optional)', async () => {
    const { apiClient, calls } = makeClient((opts) =>
      opts.parse(lightResponse('team', 'max', 139800)),
    );
    const pricing = new TokenPlanCatalogPricing(apiClient);

    const result = await pricing.getPrice(config('team', 'max'), {
      edition: 'team',
      specCode: 'max',
      authenticated: true,
    });

    expect(result.price).toBe('1398');
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('QueryOrderLight');
    expect(calls[0].authMode).toBe('optional');
  });
});
