import { describe, expect, it } from 'vitest';
import {
  NO_TOKENPLAN_COUPON,
  parseTokenPlanQuote,
} from '../../../src/api/parsers/tokenplan-trade.js';

function quoteResponse(options: {
  tradeAmount: number;
  standPrice?: number;
  discountAmount?: number;
  promotions?: unknown[];
}): Record<string, unknown> {
  return {
    successResponse: true,
    price: {
      order: {
        currency: 'CNY',
        orderLines: {},
        optionalPromotions: options.promotions ?? [],
        tradeAmount: options.tradeAmount,
        ...(options.standPrice === undefined ? {} : { standPrice: options.standPrice }),
        ...(options.discountAmount === undefined ? {} : { discountAmount: options.discountAmount }),
      },
    },
  };
}

function coupon(options: { selected: boolean; deduction?: number }): Record<string, unknown> {
  return {
    optionCode: 'youhui_quan',
    promotionOptionNo: 'coupon-test',
    promotionName: 'Test coupon',
    selected: options.selected,
    effective: true,
    ...(options.deduction === undefined ? {} : { canPromFee: options.deduction }),
  };
}

describe('parseTokenPlanQuote purchase amount layers', () => {
  it('separates original price, promotional price, coupon deduction and payable amount', () => {
    const quote = parseTokenPlanQuote(
      quoteResponse({
        standPrice: 198,
        tradeAmount: 0,
        discountAmount: 198,
        promotions: [coupon({ selected: true, deduction: 15_000 })],
      }),
      'default',
    );

    expect(quote).toMatchObject({
      originalAmount: '198',
      planAmount: '150',
      promotionDeduction: '48',
      couponDeduction: '150',
      tradeAmount: '0',
      amount: '0',
    });
  });

  it('keeps the promotional price as planAmount when coupons are disabled', () => {
    const quote = parseTokenPlanQuote(
      quoteResponse({
        standPrice: 198,
        tradeAmount: 150,
        discountAmount: 48,
        promotions: [
          {
            optionCode: 'youhui_quan',
            promotionOptionNo: NO_TOKENPLAN_COUPON,
            selected: true,
            effective: false,
          },
          coupon({ selected: false, deduction: 15_000 }),
        ],
      }),
      NO_TOKENPLAN_COUPON,
    );

    expect(quote).toMatchObject({
      originalAmount: '198',
      planAmount: '150',
      promotionDeduction: '48',
      couponDeduction: '0',
      tradeAmount: '150',
      amount: '150',
    });
  });

  it('rejects a selected coupon without a trustworthy deduction amount', () => {
    expect(() =>
      parseTokenPlanQuote(
        quoteResponse({
          standPrice: 198,
          tradeAmount: 0,
          promotions: [coupon({ selected: true })],
        }),
        'default',
      ),
    ).toThrow(expect.objectContaining({ code: 'TOKENPLAN_PROTOCOL_ERROR' }));
  });

  it('rejects a promotional price greater than the original amount', () => {
    expect(() =>
      parseTokenPlanQuote(
        quoteResponse({
          standPrice: 100,
          tradeAmount: 90,
          promotions: [coupon({ selected: true, deduction: 2_000 })],
        }),
        'default',
      ),
    ).toThrow(expect.objectContaining({ code: 'TOKENPLAN_PROTOCOL_ERROR' }));
  });
});
