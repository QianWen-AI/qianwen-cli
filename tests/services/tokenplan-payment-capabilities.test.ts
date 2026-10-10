/** Unit tests for tokenplan-payment-capabilities pure functions. */
import { describe, it, expect, vi } from 'vitest';
import {
  parsePaymentMethods,
  buildCapabilities,
  resolveDeductionIntent,
  computeFundingPlan,
  fundingPlanFingerprint,
  parseOrderSettlement,
} from '../../src/services/tokenplan-payment-capabilities.js';
import type {
  CashPaymentCapabilities,
  CashFundingPlan,
} from '../../src/types/tokenplan-payment.js';

const IDENTITY = { site: 'china-site', nbid: 'nb-123' };
const PRIMARY_ID = '300012345678901';
const SECONDARY_ID = '300012345678902';
const ORDER_IDS = [PRIMARY_ID, SECONDARY_ID] as const;
const SETTLE_KEYS = [
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
];
const CURRENCY_KEYS = [
  'SettleCurrency',
  'settleCurrency',
  'settle_currency',
  'realSettleCurrency',
  'SettCurrency',
  'Currency',
  'currency',
];
const INVALID_AMOUNTS = [
  undefined,
  null,
  '',
  ' ',
  '01',
  ' 1',
  '1 ',
  '1e2',
  '-0',
  '-1',
  '+1',
  'NaN',
  '0.0000000000001',
  true,
  false,
  {},
  [],
  Number.NaN,
  Infinity,
  -Infinity,
  -1,
  -0,
  Number.MAX_SAFE_INTEGER + 1,
];

function cashItem(overrides?: Record<string, unknown>) {
  return {
    PaymentType: 'LEGACY_ACCT_BOOK',
    BookNo: 'BOOK-001',
    PaymentMethodAvailableAmount: '100.00',
    Currency: 'CNY',
    ...overrides,
  };
}

function pcChargeItem() {
  return {
    Type: 'PLATFORM',
    PaymentTypeConfigList: [{ PaymentType: 'PcCharge_PG', Channel: 'ALIPAY' }],
  };
}

function paymentPayload(overrides?: Record<string, unknown>) {
  return {
    RequestId: 'synthetic-request',
    CreditUser: false,
    UserType: 'synthetic-user-type',
    InnerPaymentMethodList: [cashItem()],
    BizPaymentMethodList: [pcChargeItem()],
    ...overrides,
  };
}

function paymentResponse(overrides?: Record<string, unknown>) {
  return { Success: true, Code: 'Success', ...paymentPayload(overrides) };
}

function supportedCapabilities(available = '100.00'): CashPaymentCapabilities {
  return {
    admissionResult: 'supported',
    cashMethod: { available, currency: 'CNY' },
    alipayScanning: true,
    identityContext: IDENTITY,
  };
}

function settlementResponse(overrides?: Record<string, unknown>) {
  return {
    Success: true,
    Code: 'Success',
    OrderId: PRIMARY_ID,
    SettleCurrency: 'CNY',
    SettleTotalPayFee: '99.00',
    ...overrides,
  };
}

function lineResponse(overrides?: Record<string, unknown>) {
  return {
    Success: true,
    Code: 'Success',
    OrderId: PRIMARY_ID,
    SettleCurrency: 'CNY',
    OrderLines: {
      first: { SettleTotalPayFee: '10.004' },
      second: { settleTotalPayAmount: '20.004' },
    },
    ...overrides,
  };
}

function expectErrorCode(action: () => unknown, code: string) {
  expect(action).toThrow(expect.objectContaining({ name: 'CliError', code }));
}

describe('parsePaymentMethods', () => {
  it('compares payment method aliases without reading credit amounts or currency', () => {
    const forbiddenRead = vi.fn(() => {
      throw new Error('must not read credit funds');
    });
    const credit = () =>
      Object.defineProperties(
        { PaymentType: 'QUOTA_BOOK' },
        {
          PaymentMethodAvailableAmount: { enumerable: true, get: forbiddenRead },
          Currency: { enumerable: true, get: forbiddenRead },
        },
      );
    const methods = parsePaymentMethods(
      paymentResponse({
        InnerPaymentMethodList: [credit()],
        innerPaymentMethodList: [credit()],
      }),
    );
    expect(buildCapabilities(IDENTITY, methods).admissionResult).toBe('unsupported');
    expect(forbiddenRead).not.toHaveBeenCalled();
  });
  it('parses top-level cash and nested PcCharge_PG strictly', () => {
    expect(parsePaymentMethods(paymentResponse())).toEqual({
      cashMethods: [{ bookNo: 'BOOK-001', available: '100', currency: 'CNY' }],
      creditMethods: [],
      hasPcChargePG: true,
    });
  });

  it('accepts a Data wrapper and a single cash method without inventing BookNo', () => {
    const methods = parsePaymentMethods({
      Success: true,
      Code: '200',
      Data: {
        InnerPaymentMethodList: [
          {
            PaymentType: 'LEGACY_ACCT_BOOK',
            PaymentMethodAvailableAmount: '12.345678901234',
            Currency: 'CNY',
          },
        ],
        BizPaymentMethodList: [pcChargeItem()],
        SignedPaymentMethodList: [{ Channel: 'ALIPAY', Status: 'VALID' }],
      },
    });
    expect(methods?.cashMethods).toEqual([
      { bookNo: '', available: '12.345678901234', currency: 'CNY' },
    ]);
    expect(methods?.hasPcChargePG).toBe(true);
  });

  it('accepts camelCase and legacy PaymentMethodType only when explicit aliases agree', () => {
    const result = parsePaymentMethods({
      success: true,
      code: 'Success',
      data: {
        innerPaymentMethodList: [
          {
            PaymentMethodType: 'LEGACY_ACCT_BOOK',
            paymentType: 'LEGACY_ACCT_BOOK',
            bookNo: 'BOOK-001',
            PaymentMethodAvailableAmount: '100.00',
            paymentMethodAvailableAmount: 100,
            currency: 'CNY',
          },
        ],
        bizPaymentMethodList: [{ paymentTypeConfigList: [{ paymentType: 'PcCharge_PG' }] }],
      },
    });
    expect(result).toEqual(parsePaymentMethods(paymentResponse()));
  });

  it('accepts consistent top-level, Data, and data values', () => {
    const payload = paymentResponse();
    expect(parsePaymentMethods({ ...payload, Data: payload, data: payload })).toEqual(
      parsePaymentMethods(payload),
    );
  });

  describe.each(['flat', 'Data', 'data'] as const)(
    'without an inner success marker: %s',
    (wrapper) => {
      function wrap(payload: Record<string, unknown>) {
        return wrapper === 'flat' ? payload : { [wrapper]: payload };
      }

      it('accepts complete cash and QR capabilities without a duplicate business success marker', () => {
        expect(parsePaymentMethods(wrap(paymentPayload()))).toEqual({
          cashMethods: [{ bookNo: 'BOOK-001', available: '100', currency: 'CNY' }],
          creditMethods: [],
          hasPcChargePG: true,
        });
      });

      it('recognizes Alipay QR capability with an explicitly empty cash list', () => {
        expect(parsePaymentMethods(wrap(paymentPayload({ InnerPaymentMethodList: [] })))).toEqual({
          cashMethods: [],
          creditMethods: [],
          hasPcChargePG: true,
        });
      });

      it.each(['QUOTA_BOOK', 'LEGACY_CREDIT_ACCT_BOOK'])(
        'blocks minimal credit method %s without reading its limit',
        (paymentType) => {
          const methods = parsePaymentMethods(
            wrap({ InnerPaymentMethodList: [{ PaymentMethodType: paymentType }] }),
          );
          expect(buildCapabilities(IDENTITY, methods)).toMatchObject({
            admissionResult: 'unsupported',
            cashMethod: null,
            alipayScanning: false,
          });
        },
      );

      it.each([
        {},
        { InnerPaymentMethodList: [] },
        { BizPaymentMethodList: [] },
        paymentPayload({ InnerPaymentMethodList: null }),
        paymentPayload({
          InnerPaymentMethodList: [cashItem({ PaymentMethodAvailableAmount: null })],
        }),
        paymentPayload({ InnerPaymentMethodList: [cashItem({ Currency: undefined })] }),
        paymentPayload({ InnerPaymentMethodList: [cashItem({ Currency: 'USD' })] }),
        paymentPayload({ innerPaymentMethodList: [] }),
        paymentPayload({ Success: false }),
        paymentPayload({ Code: 'Denied' }),
      ])(
        'validates completeness, conflicts, and explicit failures without a success marker %#',
        (payload) => {
          expect(parsePaymentMethods(wrap(payload))).toBeNull();
        },
      );
    },
  );

  it('recognizes no cash or QR capability when both required lists are explicitly empty', () => {
    expect(parsePaymentMethods({ InnerPaymentMethodList: [], BizPaymentMethodList: [] })).toEqual({
      cashMethods: [],
      creditMethods: [],
      hasPcChargePG: false,
    });
  });

  it.each([
    null,
    undefined,
    [],
    'bad',
    1,
    {},
    paymentResponse({ Success: false }),
    paymentResponse({ Success: 'true' }),
    paymentResponse({ Code: '500' }),
    paymentResponse({ Code: '' }),
    paymentResponse({ Code: 200 }),
    paymentResponse({ success: false }),
    paymentResponse({ successResponse: false }),
    paymentResponse({ code: '200' }),
    paymentResponse({ Data: null }),
    paymentResponse({ Data: [] }),
    { Success: true, Data: paymentResponse({ Code: 'Denied' }) },
    { Success: false, Data: paymentResponse() },
    { Success: true, SignedPaymentMethodList: [] },
    { Success: true, InnerPaymentMethodList: [] },
    { Success: true, BizPaymentMethodList: [] },
  ])('rejects explicit failure, conflicting success markers, or malformed responses %#', (raw) => {
    expect(parsePaymentMethods(raw)).toBeNull();
  });

  it.each([
    { InnerPaymentMethodList: undefined },
    { InnerPaymentMethodList: null },
    { InnerPaymentMethodList: {} },
    { InnerPaymentMethodList: [null] },
    { InnerPaymentMethodList: [{}] },
    { InnerPaymentMethodList: Array(1) },
    { InnerPaymentMethodList: [{ PaymentType: 'UNRECOGNIZED' }] },
    { BizPaymentMethodList: undefined },
    { BizPaymentMethodList: null },
    { BizPaymentMethodList: {} },
    { BizPaymentMethodList: [null] },
    { BizPaymentMethodList: [{ Type: 'PLATFORM' }] },
    { BizPaymentMethodList: [{ PaymentTypeConfigList: null }] },
    { BizPaymentMethodList: [{ PaymentTypeConfigList: {} }] },
    { BizPaymentMethodList: [{ PaymentTypeConfigList: [null] }] },
    { BizPaymentMethodList: [{ PaymentTypeConfigList: [{}] }] },
    { SignedPaymentMethodList: null },
    { SignedPaymentMethodList: {} },
    { SignedPaymentMethodList: [null] },
    { innerPaymentMethodList: [] },
    { bizPaymentMethodList: [] },
    { Data: paymentResponse({ InnerPaymentMethodList: [] }) },
    { Data: paymentResponse(), data: paymentResponse({ BizPaymentMethodList: [] }) },
  ])(
    'rejects missing, malformed, or conflicting required lists and wrapper aliases %#',
    (overrides) => {
      expect(parsePaymentMethods(paymentResponse(overrides))).toBeNull();
    },
  );

  it.each(INVALID_AMOUNTS)(
    'parses cash amounts strictly through DecimalAmount.fromApi: %#',
    (amount) => {
      expect(
        parsePaymentMethods(
          paymentResponse({
            InnerPaymentMethodList: [cashItem({ PaymentMethodAvailableAmount: amount })],
          }),
        ),
      ).toBeNull();
    },
  );

  it.each([
    [0, '0'],
    [1e-7, '0.0000001'],
    ['0.00', '0'],
    ['9007199254740993.123456789012', '9007199254740993.123456789012'],
  ])('preserves valid zero and high-precision cash amounts %s', (amount, expected) => {
    expect(
      parsePaymentMethods(
        paymentResponse({
          InnerPaymentMethodList: [cashItem({ PaymentMethodAvailableAmount: amount })],
        }),
      )?.cashMethods[0].available,
    ).toBe(expected);
  });

  it.each([
    { Currency: undefined },
    { Currency: null },
    { Currency: 'USD' },
    { Currency: 'cny' },
    { Currency: ' CNY' },
    { Currency: '' },
    { Currency: true },
    { currency: 'USD' },
    { BookNo: null },
    { BookNo: '' },
    { BookNo: 1 },
    { bookNo: 'OTHER' },
    { PaymentType: undefined },
    { PaymentType: '' },
    { PaymentType: 1 },
    { PaymentMethodType: 'QUOTA_BOOK' },
    { paymentType: 'STORED_VALUE_CARD' },
    { paymentMethodAvailableAmount: '99' },
    { paymentMethodAvailableAmount: null },
  ])('requires CNY cash and rejects conflicting currency aliases %#', (overrides) => {
    expect(
      parsePaymentMethods(paymentResponse({ InnerPaymentMethodList: [cashItem(overrides)] })),
    ).toBeNull();
  });

  it('deduplicates identical cash entries without summing them', () => {
    expect(
      parsePaymentMethods(
        paymentResponse({
          InnerPaymentMethodList: [cashItem(), cashItem({ PaymentMethodAvailableAmount: 100 })],
        }),
      )?.cashMethods,
    ).toEqual([{ bookNo: 'BOOK-001', available: '100', currency: 'CNY' }]);
  });

  it.each([
    { BookNo: 'BOOK-002' },
    { Currency: 'USD' },
    { PaymentMethodAvailableAmount: '100.01' },
  ])(
    'rejects ambiguous cash entries or conflicting balances for the same ledger %#',
    (overrides) => {
      expect(
        parsePaymentMethods(
          paymentResponse({ InnerPaymentMethodList: [cashItem(), cashItem(overrides)] }),
        ),
      ).toBeNull();
    },
  );

  it.each(['QUOTA_BOOK', 'LEGACY_CREDIT_ACCT_BOOK'])(
    'does not read credit limits, currency, or cash amounts after recognizing %s',
    (paymentType) => {
      const forbiddenRead = vi.fn(() => {
        throw new Error('must not read credit funds');
      });
      const credit = Object.defineProperties(
        { PaymentType: paymentType },
        {
          PaymentMethodAvailableAmount: { enumerable: true, get: forbiddenRead },
          Currency: { enumerable: true, get: forbiddenRead },
        },
      );
      const methods = parsePaymentMethods(
        paymentResponse({
          InnerPaymentMethodList: [cashItem({ PaymentMethodAvailableAmount: null }), credit],
          BizPaymentMethodList: undefined,
        }),
      );
      expect(buildCapabilities(IDENTITY, methods)).toMatchObject({
        admissionResult: 'unsupported',
        cashMethod: null,
        alipayScanning: false,
        unsupportedReason: expect.stringContaining(paymentType),
      });
      expect(forbiddenRead).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '0', '-1', 'invalid', null])(
    'does not treat credit limit %s as cash or QR capability',
    (amount) => {
      expect(
        buildCapabilities(
          IDENTITY,
          parsePaymentMethods(
            paymentResponse({
              InnerPaymentMethodList: [
                { PaymentType: 'QUOTA_BOOK', PaymentMethodAvailableAmount: amount },
              ],
            }),
          ),
        ).admissionResult,
      ).toBe('unsupported');
    },
  );

  it('excludes stored-value cards from cash and permits QR-only payment with a complete cash list', () => {
    expect(
      buildCapabilities(
        IDENTITY,
        parsePaymentMethods(
          paymentResponse({
            InnerPaymentMethodList: [
              { PaymentType: 'STORED_VALUE_CARD', PaymentMethodAvailableAmount: '9999' },
            ],
          }),
        ),
      ),
    ).toEqual({
      identityContext: IDENTITY,
      admissionResult: 'supported',
      cashMethod: null,
      alipayScanning: true,
    });
  });

  it.each(['AlipayPcCharge_PG', 'AlipayWithhold', 'AliPayWap'])(
    'does not substitute %s or top-level Biz fields for PcCharge_PG',
    (paymentType) => {
      expect(
        parsePaymentMethods(
          paymentResponse({
            BizPaymentMethodList: [
              { PaymentType: 'PcCharge_PG', PaymentTypeConfigList: [{ PaymentType: paymentType }] },
            ],
          }),
        )?.hasPcChargePG,
      ).toBe(false);
    },
  );

  it('rejects conflicting QR configuration aliases', () => {
    expect(
      parsePaymentMethods(
        paymentResponse({
          BizPaymentMethodList: [
            {
              PaymentTypeConfigList: [
                { PaymentType: 'PcCharge_PG', paymentType: 'AlipayWithhold' },
              ],
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe('buildCapabilities', () => {
  it('keeps only validated cash amounts, CNY, and identity context in supported capabilities', () => {
    expect(buildCapabilities(IDENTITY, parsePaymentMethods(paymentResponse()))).toEqual(
      supportedCapabilities('100'),
    );
  });

  it('keeps null methods unknown without inventing QR capability', () => {
    expect(buildCapabilities(IDENTITY, null)).toEqual({
      identityContext: IDENTITY,
      admissionResult: 'unknown',
      cashMethod: null,
      alipayScanning: false,
    });
  });

  it('accepts complete empty lists with cashMethod=null to represent no cash', () => {
    expect(
      buildCapabilities(
        IDENTITY,
        parsePaymentMethods(
          paymentResponse({ InnerPaymentMethodList: [], BizPaymentMethodList: [] }),
        ),
      ),
    ).toMatchObject({ admissionResult: 'supported', cashMethod: null, alipayScanning: false });
  });

  it.each([
    [{ bookNo: 'BOOK', available: 'bad', currency: 'CNY' }],
    [{ bookNo: 'BOOK', available: '100', currency: 'USD' }],
    [
      { bookNo: 'BOOK', available: '100', currency: 'CNY' },
      { bookNo: 'BOOK', available: '99', currency: 'CNY' },
    ],
    [
      { bookNo: 'BOOK', available: '100', currency: 'CNY' },
      { bookNo: 'OTHER', available: '100', currency: 'CNY' },
    ],
  ])(
    'rejects malformed or conflicting cash records through the exported builder %#',
    (...cashMethods) => {
      expect(
        buildCapabilities(IDENTITY, { cashMethods, creditMethods: [], hasPcChargePG: true }),
      ).toMatchObject({ admissionResult: 'unknown', cashMethod: null, alipayScanning: false });
    },
  );
});

describe('resolveDeductionIntent', () => {
  it.each([
    [null, 'auto'],
    ['0', 'none'],
    ['0.00', 'none'],
    ['50.00', 'manual'],
    ['100', 'manual'],
  ])('%s preserves deduction intent %s', (amount, intent) => {
    expect(resolveDeductionIntent(amount)).toBe(intent);
  });
  it.each(['-1', '1e2', 'bad', '', ' 1'])(
    'rejects invalid deduction input %s without creating an intent',
    (amount) => {
      expect(() => resolveDeductionIntent(amount)).toThrow();
    },
  );
});

describe('computeFundingPlan', () => {
  it('produces the same plan for numerically equal quote and settlement values', () => {
    const quoted = computeFundingPlan(supportedCapabilities('50.00'), 'auto', '99.00');
    const settled = computeFundingPlan(supportedCapabilities('50'), 'auto', '99');
    expect(quoted).toEqual(settled);
    expect(quoted.orderPayable).toBe('99');
    expect(fundingPlanFingerprint(quoted)).toBe(fundingPlanFingerprint(settled));
  });
  it.each([
    ['200', '100', '100', '0'],
    ['30', '100', '30', '70'],
    ['0', '100', '0', '100'],
    ['0.004', '1.005', '0', '1.01'],
    ['10.994', '100', '10.99', '89.01'],
    ['100', '10.994', '10.99', '0'],
    ['9007199254740993.01', '9007199254740993.02', '9007199254740993.01', '0.01'],
  ])(
    'auto preserves the original payable amount and allocates cents: balance %s, payable %s',
    (available, payable, cash, external) => {
      expect(computeFundingPlan(supportedCapabilities(available), 'auto', payable)).toEqual({
        paymentMode: 'cash_alipay',
        deductionIntent: 'auto',
        orderPayable: payable,
        cashDeduction: cash,
        externalPayable: external,
      });
    },
  );

  it.each(['auto', 'none', 'manual'] as const)(
    'handles %s with no cash method without assuming a balance',
    (intent) => {
      const plan = computeFundingPlan(
        { ...supportedCapabilities(), cashMethod: null },
        intent,
        '1.005',
        intent === 'manual' ? '0' : undefined,
      );
      expect(plan).toMatchObject({
        deductionIntent: intent,
        cashDeduction: '0',
        externalPayable: '1.01',
      });
    },
  );

  it.each(['unknown', 'unsupported'] as const)(
    'rejects %s for all deduction intents even with a zero payable amount',
    (admissionResult) => {
      const capabilities = { ...supportedCapabilities(), admissionResult, cashMethod: null };
      for (const intent of ['auto', 'manual', 'none'] as const) {
        for (const payable of ['0', '100']) {
          expectErrorCode(
            () => computeFundingPlan(capabilities, intent, payable, '0'),
            admissionResult === 'unsupported'
              ? 'TOKENPLAN_PAYMENT_UNSUPPORTED'
              : 'TOKENPLAN_PAYMENT_CAPABILITY_UNKNOWN',
          );
        }
      }
    },
  );

  it('preserves a valid manual amount instead of replacing it with the maximum balance', () => {
    expect(computeFundingPlan(supportedCapabilities(), 'manual', '80', '50.00')).toMatchObject({
      deductionIntent: 'manual',
      cashDeduction: '50',
      externalPayable: '30',
    });
  });

  it.each([
    ['40', '100', '50'],
    ['100', '40', '50'],
    ['100', '0', '1'],
    ['0', '100', '0.01'],
  ])(
    'reports TOKENPLAN_BALANCE_EXCEEDED for excessive manual deductions %#',
    (available, payable, manual) => {
      expectErrorCode(
        () => computeFundingPlan(supportedCapabilities(available), 'manual', payable, manual),
        'TOKENPLAN_BALANCE_EXCEEDED',
      );
    },
  );

  it('reports balance exceeded for a positive manual deduction without a cash method', () => {
    expectErrorCode(
      () =>
        computeFundingPlan({ ...supportedCapabilities(), cashMethod: null }, 'manual', '100', '1'),
      'TOKENPLAN_BALANCE_EXCEEDED',
    );
  });

  it.each(['0.001', '0.005', '1.001', '1.000'])(
    'rejects sub-cent or excess-precision manual input %s as malformed',
    (manual) => {
      expectErrorCode(
        () => computeFundingPlan(supportedCapabilities('0'), 'manual', '0', manual),
        'TOKENPLAN_INVALID_DEDUCTION',
      );
    },
  );

  it.each([undefined, '', '-1', '1e2', 'bad'])(
    'rejects missing or invalid manual amounts %#',
    (manual) => {
      expect(() => computeFundingPlan(supportedCapabilities(), 'manual', '80', manual)).toThrow();
    },
  );

  it.each([
    ['0.005', '100'],
    ['100', '0.005'],
    ['10.995', '100'],
    ['100', '10.995'],
    ['0.009', '0.009'],
  ])(
    'rejects out-of-range rounded allocations without clamping or sending sub-cent values %#',
    (available, payable) => {
      expectErrorCode(
        () => computeFundingPlan(supportedCapabilities(available), 'auto', payable),
        'TOKENPLAN_DEDUCTION_BOUNDARY',
      );
    },
  );

  it('none computes only the external cent amount even when cash is available', () => {
    expect(computeFundingPlan(supportedCapabilities(), 'none', '80.005')).toMatchObject({
      deductionIntent: 'none',
      cashDeduction: '0',
      externalPayable: '80.01',
    });
  });

  it.each(['auto', 'manual', 'none'] as const)(
    'preserves %s intent for a zero payable amount',
    (intent) => {
      expect(
        computeFundingPlan(
          supportedCapabilities(),
          intent,
          '0',
          intent === 'manual' ? '0' : undefined,
        ),
      ).toMatchObject({ deductionIntent: intent, cashDeduction: '0', externalPayable: '0' });
    },
  );

  it('validates cash capability and payable amount even when cash deduction is disabled', () => {
    expect(() => computeFundingPlan(supportedCapabilities('bad'), 'none', '100')).toThrow();
    expect(() => computeFundingPlan(supportedCapabilities(), 'auto', '-1')).toThrow();
  });
});

describe('fundingPlanFingerprint', () => {
  const plan: CashFundingPlan = {
    paymentMode: 'cash_alipay',
    deductionIntent: 'auto',
    orderPayable: '100.00',
    cashDeduction: '50',
    externalPayable: '50',
  };
  it('produces identical fingerprints for identical plans', () => {
    expect(fundingPlanFingerprint(plan)).toBe(fundingPlanFingerprint({ ...plan }));
  });
  it.each([
    { deductionIntent: 'manual' as const },
    { cashDeduction: '49.99' },
    { externalPayable: '50.01' },
  ])('invalidates confirmation when deduction intent or allocation changes %#', (overrides) => {
    expect(fundingPlanFingerprint(plan)).not.toBe(
      fundingPlanFingerprint({ ...plan, ...overrides }),
    );
  });
});

describe('parseOrderSettlement', () => {
  it.each(SETTLE_KEYS)('parses settlement alias %s strictly and preserves its precision', (key) => {
    expect(
      parseOrderSettlement(
        { Success: true, OrderId: PRIMARY_ID, Currency: 'CNY', [key]: '99.005' },
        PRIMARY_ID,
      ),
    ).toEqual({ settledPayable: '99.005', orderId: PRIMARY_ID, currency: 'CNY' });
  });

  it('preserves explicit zero settlement and accepts numerically consistent amount aliases', () => {
    expect(
      parseOrderSettlement(
        settlementResponse(
          Object.fromEntries(SETTLE_KEYS.map((key, index) => [key, index % 2 ? 0 : '0.00'])),
        ),
        PRIMARY_ID,
      ).settledPayable,
    ).toBe('0');
  });

  it.each(CURRENCY_KEYS)('accepts settlement currency alias %s', (key) => {
    expect(
      parseOrderSettlement(
        { Success: true, OrderId: PRIMARY_ID, SettleTotalPayFee: '1', [key]: 'CNY' },
        PRIMARY_ID,
      ).currency,
    ).toBe('CNY');
  });

  it('accepts safe numeric order IDs and preserves large string IDs in a successful Data wrapper', () => {
    const raw = {
      Code: '200',
      Success: true,
      Data: {
        OrderId: Number(PRIMARY_ID),
        orderId: PRIMARY_ID,
        SettleCurrency: 'CNY',
        SettleTotalPayFee: '9.99',
      },
    };
    expect(parseOrderSettlement(raw, PRIMARY_ID).orderId).toBe(PRIMARY_ID);
    const largeId = '900719925474099312345';
    expect(parseOrderSettlement(settlementResponse({ OrderId: largeId }), largeId).orderId).toBe(
      largeId,
    );
  });

  it('accepts consistent top-level and Data/data wrappers', () => {
    const payload = settlementResponse();
    expect(
      parseOrderSettlement({ ...payload, Data: payload, data: payload }, PRIMARY_ID).settledPayable,
    ).toBe('99');
  });

  it('accepts the QueryOrderDetail business payload after gateway success validation', () => {
    expect(
      parseOrderSettlement(
        {
          RequestId: 'synthetic-request',
          Data: {
            OrderId: PRIMARY_ID,
            Currency: 'CNY',
            PayAmount: '79.20',
            TradeAmount: '79.20',
            OrderLines: {
              first: {
                OrderId: PRIMARY_ID,
                Currency: 'CNY',
                PayAmount: '79.20',
                TradeAmount: '79.20',
              },
            },
          },
        },
        PRIMARY_ID,
      ),
    ).toEqual({ settledPayable: '79.2', orderId: PRIMARY_ID, currency: 'CNY' });
  });

  it.each([
    null,
    undefined,
    [],
    'bad',
    1,
    {},
    settlementResponse({ Success: false }),
    settlementResponse({ Success: 'true' }),
    settlementResponse({ success: false }),
    settlementResponse({ successResponse: false }),
    settlementResponse({ Code: 'Denied' }),
    settlementResponse({ Code: 200 }),
    settlementResponse({ code: '200' }),
    settlementResponse({ Code: undefined }),
    settlementResponse({ Data: null }),
    settlementResponse({ Data: [] }),
    { Success: false, Data: settlementResponse() },
    { Success: true, Data: settlementResponse({ Code: 'Failed' }) },
    settlementResponse({ Data: settlementResponse({ SettleTotalPayFee: '98' }) }),
    {
      Success: true,
      Data: settlementResponse(),
      data: settlementResponse({ SettleTotalPayFee: '98' }),
    },
    settlementResponse({
      SettleTotalPayFee: '1.001',
      Data: settlementResponse({ SettleTotalPayFee: '1.002' }),
    }),
  ])('rejects explicit failure, malformed wrappers, or wrapper conflicts %#', (raw) => {
    expectErrorCode(() => parseOrderSettlement(raw, PRIMARY_ID), 'TOKENPLAN_SETTLEMENT_PARSE');
  });

  it.each(INVALID_AMOUNTS)('rejects every invalid settlement amount %#', (amount) => {
    expect(() =>
      parseOrderSettlement(settlementResponse({ SettleTotalPayFee: amount }), PRIMARY_ID),
    ).toThrow();
  });

  it.each(SETTLE_KEYS)(
    'requires all explicit settlement aliases including %s to be valid and consistent',
    (key) => {
      const raw = {
        Success: true,
        OrderId: PRIMARY_ID,
        Currency: 'CNY',
        ...Object.fromEntries(SETTLE_KEYS.map((alias) => [alias, '99'])),
      };
      for (const conflicting of [undefined, null, 'bad', '99.001']) {
        expect(() => parseOrderSettlement({ ...raw, [key]: conflicting }, PRIMARY_ID)).toThrow();
      }
    },
  );

  it.each(['OriginalAmount', 'originalAmount', 'TotalAmount', 'TaxAmount'])(
    'does not use %s as a settlement fallback',
    (key) => {
      expect(() =>
        parseOrderSettlement(
          { Success: true, OrderId: PRIMARY_ID, Currency: 'CNY', [key]: '99' },
          PRIMARY_ID,
        ),
      ).toThrow();
    },
  );

  it('rejects missing settlement instead of falling back to the quote', () => {
    expectErrorCode(
      () =>
        parseOrderSettlement({ Success: true, OrderId: PRIMARY_ID, Currency: 'CNY' }, PRIMARY_ID),
      'TOKENPLAN_SETTLEMENT_PARSE',
    );
  });

  it.each([undefined, null, '', 'USD', 'cny', ' CNY', true])(
    'rejects missing or invalid currency without assuming CNY %#',
    (currency) => {
      expect(() =>
        parseOrderSettlement(settlementResponse({ SettleCurrency: currency }), PRIMARY_ID),
      ).toThrow();
    },
  );

  it('requires all currency aliases to agree including unselected aliases', () => {
    const same = Object.fromEntries(CURRENCY_KEYS.map((key) => [key, 'CNY']));
    expect(parseOrderSettlement(settlementResponse(same), PRIMARY_ID).currency).toBe('CNY');
    for (const key of CURRENCY_KEYS) {
      expectErrorCode(
        () => parseOrderSettlement(settlementResponse({ ...same, [key]: 'USD' }), PRIMARY_ID),
        'TOKENPLAN_SETTLEMENT_CURRENCY',
      );
    }
  });

  it.each([
    undefined,
    null,
    '',
    '0',
    '01',
    'ORDER-001',
    ` ${PRIMARY_ID}`,
    0,
    -1,
    1.1,
    true,
    {},
    [],
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects untrusted order IDs without coercion or expectedId fallback %#', (orderId) => {
    expect(() =>
      parseOrderSettlement(settlementResponse({ OrderId: orderId }), PRIMARY_ID),
    ).toThrow();
  });

  it('rejects order ID mismatches and conflicting aliases', () => {
    expectErrorCode(
      () => parseOrderSettlement(settlementResponse({ OrderId: SECONDARY_ID }), PRIMARY_ID),
      'TOKENPLAN_SETTLEMENT_MISMATCH',
    );
    expect(() =>
      parseOrderSettlement(settlementResponse({ orderId: SECONDARY_ID }), PRIMARY_ID),
    ).toThrow();
  });

  it.each(['OrderLines', 'orderLines', 'orderLineList'])(
    'sums all %s order lines without rounding individual lines',
    (key) => {
      const lines = [{ SettleTotalPayFee: '10.004' }, { settleTotalPayAmount: '20.004' }];
      const payload = {
        OrderId: PRIMARY_ID,
        SettleCurrency: 'CNY',
        [key]: key === 'orderLineList' ? lines : { first: lines[0], second: lines[1] },
      };
      expect(
        parseOrderSettlement({ Code: 'Success', Success: true, Data: payload }, PRIMARY_ID),
      ).toEqual({ settledPayable: '30.008', orderId: PRIMARY_ID, currency: 'CNY' });
    },
  );

  it('uses firstOrderLine only for a single order without a complete line container', () => {
    expect(
      parseOrderSettlement(
        {
          Success: true,
          OrderId: PRIMARY_ID,
          SettleCurrency: 'CNY',
          firstOrderLine: { SettleTotalPayFee: '30.005' },
        },
        PRIMARY_ID,
      ).settledPayable,
    ).toBe('30.005');
  });

  it('does not double-count a consistent firstOrderLine and complete list regardless of order', () => {
    const first = { OrderId: PRIMARY_ID, SettleTotalPayFee: '10.004' };
    const second = { OrderId: PRIMARY_ID, SettleTotalPayFee: '20.004' };
    expect(
      parseOrderSettlement(
        lineResponse({
          OrderLines: { first, second },
          orderLines: { second, first },
          orderLineList: [second, first],
          firstOrderLine: first,
          SettleTotalPayAmount: '30.008',
        }),
        PRIMARY_ID,
      ).settledPayable,
    ).toBe('30.008');
  });

  it('accepts explicit line-level CNY and rejects missing currency on every line', () => {
    expect(
      parseOrderSettlement(
        {
          Success: true,
          OrderId: PRIMARY_ID,
          orderLineList: [
            { SettleCurrency: 'CNY', SettleTotalPayFee: '1' },
            { Currency: 'CNY', settleTotalPayAmount: '2' },
          ],
        },
        PRIMARY_ID,
      ).settledPayable,
    ).toBe('3');
    expect(() =>
      parseOrderSettlement(
        { Success: true, OrderId: PRIMARY_ID, orderLineList: [{ SettleTotalPayFee: '1' }] },
        PRIMARY_ID,
      ),
    ).toThrow();
  });

  it.each([
    { OrderLines: null },
    { OrderLines: [] },
    { OrderLines: {} },
    { OrderLines: 'bad' },
    { OrderLines: { first: null } },
    { OrderLines: { first: { OriginalAmount: '30' } } },
    { orderLineList: null },
    { orderLineList: {} },
    { orderLineList: [] },
    { firstOrderLine: null },
    { firstOrderLine: {} },
    { orderLines: { first: { SettleTotalPayFee: '30.008' } } },
    { firstOrderLine: { SettleTotalPayFee: '99' } },
    { SettleTotalPayFee: '30.009' },
    {
      OrderLines: { first: { SettleTotalPayFee: '10' }, second: { OriginalAmount: '20' } },
      SettleTotalPayFee: '30',
    },
    { OrderLines: { first: { SettleTotalPayFee: '30.008', Currency: 'USD' } } },
    { OrderLines: { first: { SettleTotalPayFee: '30.008', settleTotalPayFee: '30' } } },
    { OrderLines: { first: { SettleTotalPayFee: '30.008', OrderId: SECONDARY_ID } } },
    {
      OrderLines: {
        first: { SettleTotalPayFee: '30.008', OrderId: PRIMARY_ID, orderId: SECONDARY_ID },
      },
    },
  ])(
    'rejects incomplete lines, field conflicts, or inconsistent top-level totals %#',
    (overrides) => {
      expect(() => parseOrderSettlement(lineResponse(overrides), PRIMARY_ID)).toThrow();
    },
  );

  it('accepts complete OrderIds as proof of multi-order scope regardless of order', () => {
    expect(
      parseOrderSettlement(
        settlementResponse({ OrderIds: [...ORDER_IDS].reverse(), orderIds: ORDER_IDS }),
        PRIMARY_ID,
        ORDER_IDS,
      ).settledPayable,
    ).toBe('99');
  });

  it('accepts complete line-level OrderIds with multiple lines per order', () => {
    const raw = lineResponse({
      OrderLines: {
        first: { OrderId: PRIMARY_ID, SettleTotalPayFee: '10.004' },
        second: { OrderId: SECONDARY_ID, SettleTotalPayFee: '20.004' },
        third: { orderId: SECONDARY_ID, SettleTotalPayFee: '0.002' },
      },
    });
    expect(parseOrderSettlement(raw, PRIMARY_ID, ORDER_IDS).settledPayable).toBe('30.01');
  });

  it('associates complete OrderIds with a complete line list lacking individual order IDs', () => {
    expect(
      parseOrderSettlement(lineResponse({ OrderIds: ORDER_IDS }), PRIMARY_ID, ORDER_IDS)
        .settledPayable,
    ).toBe('30.008');
  });

  it.each([
    settlementResponse(),
    settlementResponse({ OrderIds: [PRIMARY_ID] }),
    settlementResponse({ OrderIds: [SECONDARY_ID] }),
    settlementResponse({ OrderIds: [...ORDER_IDS, '300012345678903'] }),
    settlementResponse({ OrderIds: [PRIMARY_ID, PRIMARY_ID] }),
    settlementResponse({ OrderIds: [] }),
    settlementResponse({ OrderIds: null }),
    settlementResponse({ OrderIds: {} }),
    settlementResponse({ OrderIds: ORDER_IDS, orderIds: [PRIMARY_ID] }),
    lineResponse(),
    lineResponse({
      OrderLines: {
        [PRIMARY_ID]: { SettleTotalPayFee: '1' },
        [SECONDARY_ID]: { SettleTotalPayFee: '2' },
      },
    }),
    lineResponse({ OrderLines: { first: { OrderId: PRIMARY_ID, SettleTotalPayFee: '10' } } }),
    lineResponse({
      OrderIds: ORDER_IDS,
      OrderLines: { first: { OrderId: PRIMARY_ID, SettleTotalPayFee: '10' } },
    }),
    lineResponse({
      OrderLines: {
        first: { OrderId: PRIMARY_ID, SettleTotalPayFee: '10' },
        second: { SettleTotalPayFee: '20' },
      },
    }),
    {
      Success: true,
      OrderId: PRIMARY_ID,
      OrderIds: ORDER_IDS,
      SettleCurrency: 'CNY',
      firstOrderLine: { OrderId: PRIMARY_ID, SettleTotalPayFee: '10' },
    },
  ])('rejects incomplete, missing, or conflicting multi-order scope %#', (raw) => {
    expect(() => parseOrderSettlement(raw, PRIMARY_ID, ORDER_IDS)).toThrow();
  });

  it('rejects contradictions between declared multi-order scope and complete lines', () => {
    expect(() =>
      parseOrderSettlement(
        lineResponse({
          OrderIds: [PRIMARY_ID],
          OrderLines: {
            first: { OrderId: PRIMARY_ID, SettleTotalPayFee: '10' },
            second: { OrderId: SECONDARY_ID, SettleTotalPayFee: '20' },
          },
        }),
        PRIMARY_ID,
        ORDER_IDS,
      ),
    ).toThrow();
  });

  it.each([[], [SECONDARY_ID], [PRIMARY_ID, PRIMARY_ID], [PRIMARY_ID, 'invalid']])(
    'requires the expected order set to be valid %#',
    (...expectedIds) => {
      expect(() => parseOrderSettlement(settlementResponse(), PRIMARY_ID, expectedIds)).toThrow();
    },
  );

  it('rejects extra orders in an explicit set for the default single-order scope', () => {
    expect(() =>
      parseOrderSettlement(settlementResponse({ OrderIds: ORDER_IDS }), PRIMARY_ID),
    ).toThrow();
  });
});
