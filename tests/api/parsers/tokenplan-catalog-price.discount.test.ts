import { describe, expect, it } from 'vitest';
import { parseTokenPlanCatalogPrice } from '../../../src/api/parsers/tokenplan-catalog-price.js';
import { site } from '../../../src/site.js';

function configuration(
  edition: 'individual' | 'team',
  specCode: string,
  duration: string,
  pricingCycle: 'Month' | 'Year',
): Record<string, unknown> {
  const commodityCode =
    edition === 'individual'
      ? site.features.tokenPlanCommodityCodes.soloBuy
      : site.features.tokenPlanCommodityCodes.teams;
  return {
    commodityCode,
    specCode: commodityCode,
    duration,
    pricingCycle,
    components: [
      {
        instanceProperty: [
          {
            code: edition === 'individual' ? 'subscription_type' : 'plan_type',
            value: specCode,
          },
        ],
      },
    ],
  };
}

/**
 * Model a QueryOrderLight response where price.articleItemResults[] carries the tier
 * through moduleResults.moduleAttributeMap and stores current and original amounts in cents.
 */
function lightResponse(
  edition: 'individual' | 'team',
  specCode: string,
  fields: {
    standPrice?: number;
    standDiscountPrice?: number;
    settlementPrice?: number;
    discountedPrice?: number;
    discountedTotalPrice?: number;
    unitPrice?: number;
    totalPrice?: number;
  },
): unknown {
  const commodityCode =
    edition === 'individual'
      ? site.features.tokenPlanCommodityCodes.soloBuy
      : site.features.tokenPlanCommodityCodes.teams;
  const tierKey = edition === 'individual' ? 'subscription_type' : 'plan_type';
  return {
    code: '200',
    message: 'SUCCEED',
    price: {
      articleItemResults: [
        {
          code: commodityCode,
          articleItemName: 'Token Plan',
          ...(fields.standPrice === undefined ? {} : { standPrice: fields.standPrice }),
          ...(fields.standDiscountPrice === undefined
            ? {}
            : { standDiscountPrice: fields.standDiscountPrice }),
          ...(fields.settlementPrice === undefined
            ? {}
            : {
                settlement: { settlementCurrency: 'CNY', settlementPrice: fields.settlementPrice },
              }),
          ...(fields.discountedPrice === undefined &&
          fields.discountedTotalPrice === undefined &&
          fields.unitPrice === undefined &&
          fields.totalPrice === undefined
            ? {}
            : {
                price: {
                  ...(fields.unitPrice === undefined ? {} : { unitPrice: fields.unitPrice }),
                  ...(fields.totalPrice === undefined ? {} : { totalPrice: fields.totalPrice }),
                  ...(fields.discountedTotalPrice === undefined
                    ? {}
                    : { discountedTotalPrice: fields.discountedTotalPrice }),
                  ...(fields.discountedPrice === undefined
                    ? {}
                    : { discountedPrice: fields.discountedPrice }),
                },
              }),
          moduleResults: [{ moduleAttributeMap: { [tierKey]: specCode } }],
        },
      ],
    },
  };
}

describe('parseTokenPlanCatalogPrice — pricing card fields', () => {
  it.each([
    // [name, edition, specCode, duration, cycle, total, discountedTotal, expected]
    ['individual lite quarterly', 'individual', 'lite', '3', 'Month', 11700, 11000, '110'],
    ['individual standard quarterly', 'individual', 'standard', '3', 'Month', 54000, 39600, '396'],
    ['individual pro monthly', 'individual', 'pro', '1', 'Month', 49900, 49900, '499'],
    ['team standard monthly', 'team', 'standard', '1', 'Month', 19800, 15000, '150'],
    ['team pro monthly', 'team', 'pro', '1', 'Month', 69800, 55000, '550'],
    ['team max monthly (no promo)', 'team', 'max', '1', 'Month', 139800, 139800, '1398'],
    ['team standard yearly', 'team', 'standard', '1', 'Year', 237600, 180000, '1800'],
  ] as const)(
    'reads price.discountedTotalPrice for %s',
    (_name, edition, specCode, duration, cycle, total, discountedTotal, expected) => {
      expect(
        parseTokenPlanCatalogPrice(
          lightResponse(edition, specCode, {
            totalPrice: total,
            discountedTotalPrice: discountedTotal,
          }),
          configuration(edition, specCode, duration, cycle),
          { edition, specCode },
        ).price,
      ).toBe(expected);
    },
  );

  it.each([
    { settlementPrice: 11000 },
    { discountedPrice: 11000 },
    { standPrice: 11700, standDiscountPrice: 700 },
  ])('does not fall back to legacy price fields: %j', (fields) => {
    expect(() =>
      parseTokenPlanCatalogPrice(
        lightResponse('individual', 'lite', fields),
        configuration('individual', 'lite', '3', 'Month'),
        { edition: 'individual', specCode: 'lite' },
      ),
    ).toThrowError('Token Plan catalog price is missing');
  });

  it('returns totalPrice separately and ignores conflicting legacy fields', () => {
    expect(
      parseTokenPlanCatalogPrice(
        lightResponse('individual', 'standard', {
          standPrice: 41700,
          standDiscountPrice: 2100,
          settlementPrice: 39600,
          discountedPrice: 99999,
          discountedTotalPrice: 39600,
          unitPrice: 54000,
          totalPrice: 54000,
        }),
        configuration('individual', 'standard', '3', 'Month'),
        { edition: 'individual', specCode: 'standard' },
      ),
    ).toMatchObject({ price: '396', originalPrice: '540' });
  });

  it('reads team monthly Credits from the subscription_spec module', () => {
    const data = lightResponse('team', 'standard', {
      discountedTotalPrice: 15000,
    }) as {
      price: { articleItemResults: Array<Record<string, unknown>> };
    };
    data.price.articleItemResults[0]!.moduleResults = [
      {
        moduleCode: 'subscription_spec',
        moduleAttributeMap: { plan_type: 'standard', credit_value: '25000' },
      },
    ];

    expect(
      parseTokenPlanCatalogPrice(data, configuration('team', 'standard', '1', 'Month'), {
        edition: 'team',
        specCode: 'standard',
      }),
    ).toMatchObject({ price: '150', monthlyCredits: '25000' });
  });

  it('does not use standPrice or unitPrice when totalPrice is absent', () => {
    expect(
      parseTokenPlanCatalogPrice(
        lightResponse('individual', 'standard', {
          standPrice: 54000,
          unitPrice: 54000,
          discountedTotalPrice: 39600,
        }),
        configuration('individual', 'standard', '3', 'Month'),
        { edition: 'individual', specCode: 'standard' },
      ),
    ).toMatchObject({ price: '396', originalPrice: null });
  });
});

describe('parseTokenPlanCatalogPrice edge cases', () => {
  const teamCommodity = site.features.tokenPlanCommodityCodes.teams;
  const individualCommodity = site.features.tokenPlanCommodityCodes.soloBuy;

  it('returns unknownPrice when articleItemResults is absent despite order.standPrice', () => {
    const data = {
      code: '200',
      message: 'SUCCEED',
      price: {
        order: {
          standPrice: 117,
          currency: 'CNY',
        },
      },
    };
    expect(() =>
      parseTokenPlanCatalogPrice(data, configuration('individual', 'lite', '3', 'Month'), {
        edition: 'individual',
        specCode: 'lite',
      }),
    ).toThrowError('Token Plan catalog price is missing');
  });

  it('returns unknownPrice when the target article has no price fields', () => {
    const data = {
      code: '200',
      message: 'SUCCEED',
      price: {
        articleItemResults: [
          {
            articleItemCode: individualCommodity,
            articleItemName: 'Token Plan',
            moduleResults: [{ moduleAttributeMap: { subscription_type: 'lite' } }],
          },
        ],
      },
    };
    expect(() =>
      parseTokenPlanCatalogPrice(data, configuration('individual', 'lite', '3', 'Month'), {
        edition: 'individual',
        specCode: 'lite',
      }),
    ).toThrowError('Token Plan catalog price is missing');
  });

  it('returns unknownPrice for an invalid discountedTotalPrice', () => {
    const data = {
      code: '200',
      message: 'SUCCEED',
      price: {
        articleItemResults: [
          {
            articleItemCode: teamCommodity,
            articleItemName: 'Token Plan',
            price: { discountedTotalPrice: 'invalid' },
            moduleResults: [{ moduleAttributeMap: { plan_type: 'standard' } }],
          },
        ],
      },
    };
    expect(() =>
      parseTokenPlanCatalogPrice(data, configuration('team', 'standard', '1', 'Month'), {
        edition: 'team',
        specCode: 'standard',
      }),
    ).toThrowError('Token Plan catalog price is missing');
  });

  it.each([
    { settlement: { settlementCurrency: 'USD' } },
    { settlement: { currency: 'USD' } },
    { priceCurrency: 'USD' },
  ])(
    'returns unknownPrice for conflicting nested currencies $settlement$priceCurrency',
    (currencyFields) => {
      const data = lightResponse('team', 'standard', {
        discountedTotalPrice: 15000,
      }) as {
        price: { articleItemResults: Array<Record<string, unknown>> };
      };
      const article = data.price.articleItemResults[0]!;
      if (currencyFields.settlement) article.settlement = currencyFields.settlement;
      if (currencyFields.priceCurrency) {
        article.price = {
          ...(article.price as Record<string, unknown>),
          currency: currencyFields.priceCurrency,
        };
      }

      expect(() =>
        parseTokenPlanCatalogPrice(data, configuration('team', 'standard', '1', 'Month'), {
          edition: 'team',
          specCode: 'standard',
        }),
      ).toThrowError('Token Plan catalog price is missing');
    },
  );

  it('legacy fields conflict with discountedTotalPrice → trusts the card field', () => {
    const data = {
      code: '200',
      message: 'SUCCEED',
      price: {
        articleItemResults: [
          {
            articleItemCode: teamCommodity,
            articleItemName: 'Token Plan',
            standPrice: 19800,
            standDiscountPrice: 1000,
            settlement: { settlementCurrency: 'CNY', settlementPrice: 15000 },
            price: { discountedPrice: 99999, discountedTotalPrice: 15000 },
            moduleResults: [{ moduleAttributeMap: { plan_type: 'standard' } }],
          },
        ],
      },
    };
    expect(
      parseTokenPlanCatalogPrice(data, configuration('team', 'standard', '1', 'Month'), {
        edition: 'team',
        specCode: 'standard',
      }).price,
    ).toBe('150');
  });

  it('ignores a list price below the current price while preserving the current price', () => {
    expect(
      parseTokenPlanCatalogPrice(
        lightResponse('individual', 'standard', {
          standPrice: 39000,
          settlementPrice: 39600,
          discountedTotalPrice: 39600,
          unitPrice: 39000,
          totalPrice: 39000,
        }),
        configuration('individual', 'standard', '3', 'Month'),
        { edition: 'individual', specCode: 'standard' },
      ),
    ).toMatchObject({ price: '396', originalPrice: null });
  });
});
