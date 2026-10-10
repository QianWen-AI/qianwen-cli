/** Unit tests for TokenPlanPurchaseService — balance deduction flows. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TokenPlanQuote, TokenPlanSelection } from '../../src/types/tokenplan-purchase.js';
import type {
  CashPaymentCapabilities,
  TokenPlanMergePayInput,
} from '../../src/types/tokenplan-payment.js';
import type {
  TokenPlanPurchaseDecision,
  TokenPlanPurchaseInteraction,
} from '../../src/services/tokenplan-purchase-service.js';
import { CliError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Module mocks — control the sub-services from outside
// ---------------------------------------------------------------------------

const mockGetCommodity = vi.fn();
const mockGetQuote = vi.fn();
const mockCheckInventory = vi.fn();

vi.mock('../../src/services/tokenplan-trade-service.js', () => ({
  TokenPlanTradeService: class {
    getCommodity = mockGetCommodity;
    getQuote = mockGetQuote;
    checkInventory = mockCheckInventory;
  },
}));

const mockCheckAccount = vi.fn();
const mockGetPaymentCapabilities = vi.fn();

vi.mock('../../src/services/tokenplan-purchase-gates.js', () => ({
  TokenPlanPurchaseGates: class {
    checkAccount = mockCheckAccount;
    getPaymentCapabilities = mockGetPaymentCapabilities;
  },
}));

const mockCreateOrders = vi.fn();
const mockMergePay = vi.fn();
const mockGetOrderSettlement = vi.fn();
const mockWaitForPaymentResult = vi.fn();

vi.mock('../../src/services/tokenplan-payment-service.js', () => ({
  PAYMENT_POLL_TIMEOUT_MS: 60_000,
  TokenPlanPaymentService: class {
    createOrders = mockCreateOrders;
    mergePay = (input: TokenPlanMergePayInput) => mockMergePay(input);
    getOrderSettlement = mockGetOrderSettlement;
    waitForPaymentResult = mockWaitForPaymentResult;
  },
}));

const mockGetCatalogPrice = vi.fn();

vi.mock('../../src/services/tokenplan-catalog-pricing.js', () => ({
  buildTokenPlanCatalogConfiguration: vi.fn(() => ({
    commodityCode: 'test',
    specCode: 'standard',
  })),
  TokenPlanCatalogPricing: class {
    getPrice = mockGetCatalogPrice;
  },
}));

vi.mock('../../src/services/tokenplan-configuration.js', () => ({
  buildTokenPlanConfigurations: () => [{ commodityCode: 'test', specCode: 'standard' }],
  tokenPlanCommodityCode: () => 'sfm_tokenplanpersonal_dp_cn',
}));

vi.mock('../../src/services/tokenplan-deadline.js', () => ({
  withTokenPlanDeadline: (operation: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    return operation(controller.signal);
  },
  tokenPlanSleep: () => Promise.resolve(),
}));

// Import after mocks are set up
const { TokenPlanPurchaseService } =
  await import('../../src/services/tokenplan-purchase-service.js');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SELECTION: TokenPlanSelection = {
  type: 'token_plan_individual_standard',
  edition: 'individual',
  billingCycle: 'monthly',
  seats: [{ specCode: 'standard', quantity: 1 }],
  autoRenew: false,
  balanceDeduction: null,
};

function makeQuote(overrides?: Partial<TokenPlanQuote>): TokenPlanQuote {
  return {
    amount: '99.00',
    tradeAmount: '99.00',
    currency: 'CNY',
    coupon: 'default',
    coupons: [],
    originalAmount: '99.00',
    planAmount: '99.00',
    promotionDeduction: '0',
    couponDeduction: '0',
    ...overrides,
  };
}

function makeCapabilities(available = '200.00'): CashPaymentCapabilities {
  return {
    admissionResult: 'supported',
    cashMethod: { available, currency: 'CNY' },
    alipayScanning: true,
    identityContext: { site: 'china-site', nbid: 'nb-123' },
  };
}

function confirmInteraction(): TokenPlanPurchaseInteraction {
  return {
    review: vi.fn().mockResolvedValue({ action: 'confirm' } satisfies TokenPlanPurchaseDecision),
    payment: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Default mocks for the happy path
  mockGetCommodity.mockResolvedValue({ commodityCode: 'test' });
  mockGetQuote.mockImplementation(async () => makeQuote());
  mockCheckInventory.mockResolvedValue(undefined);
  mockCheckAccount.mockResolvedValue(undefined);
  mockGetPaymentCapabilities.mockImplementation(async () => makeCapabilities());
  mockGetCatalogPrice.mockResolvedValue({
    price: '99',
    originalPrice: null,
    currency: 'CNY',
    monthlyCredits: null,
  });
  mockCreateOrders.mockResolvedValue({
    paymentOrderId: 'PAY-001',
    orderIds: ['ORD-001'],
  });
  mockGetOrderSettlement.mockResolvedValue({
    settledPayable: '99.00',
    orderId: 'PAY-001',
    currency: 'CNY',
  });
  mockMergePay.mockImplementation(async (input: TokenPlanMergePayInput) => {
    input.onRequestStart?.();
    return { status: 'succeeded', url: null };
  });
  mockWaitForPaymentResult.mockResolvedValue({
    orderId: 'PAY-001',
    status: 'succeeded',
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenPlanPurchaseService quote progress', () => {
  it('notifies before the preview quote completes without creating an order', async () => {
    const onQuoteStart = vi.fn();
    mockGetQuote.mockImplementationOnce(async () => {
      expect(onQuoteStart).toHaveBeenCalledTimes(1);
      return makeQuote();
    });

    await new TokenPlanPurchaseService({} as never).preview(
      SELECTION,
      undefined,
      undefined,
      onQuoteStart,
    );

    expect(onQuoteStart).toHaveBeenCalledTimes(1);
    expect(mockCreateOrders).not.toHaveBeenCalled();
  });

  it('notifies before initial, coupon, and confirmation quotes without repeating for local balance recalculation', async () => {
    const onQuoteStart = vi.fn();
    const events: string[] = [];
    onQuoteStart.mockImplementation(() => events.push('preparing'));
    let quoteCount = 0;
    mockGetQuote.mockImplementation(async (_configurations, coupon: string) => {
      events.push('request');
      quoteCount += 1;
      return makeQuote({
        coupon,
        coupons: [{ id: 'coupon-a', name: 'Test coupon' }],
        ...(quoteCount >= 3 ? { amount: '90', tradeAmount: '90' } : {}),
      });
    });
    const interaction = { ...confirmInteraction(), onQuoteStart };
    vi.mocked(interaction.review)
      .mockResolvedValueOnce({ action: 'coupon', coupon: 'coupon-a' })
      .mockResolvedValueOnce({ action: 'balance', amount: '10' })
      .mockResolvedValueOnce({ action: 'confirm' })
      .mockResolvedValueOnce({ action: 'confirm' })
      .mockResolvedValueOnce({ action: 'cancel' });
    // Settlement changes after creation require another review, not another quote.
    mockGetOrderSettlement.mockResolvedValueOnce({
      settledPayable: '100',
      orderId: 'PAY-001',
      currency: 'CNY',
    });

    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );

    expect(outcome.result.status).toBe('cancelled');
    expect(interaction.review).toHaveBeenCalledTimes(5);
    expect(onQuoteStart).toHaveBeenCalledTimes(4);
    expect(events).toEqual(Array.from({ length: 4 }, () => ['preparing', 'request']).flat());
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it.each(['preview', 'purchase'] as const)(
    '%s notifies once before a quote failure',
    async (mode) => {
      const onQuoteStart = vi.fn();
      const error = new CliError({ code: 'TOKENPLAN_TIMEOUT', message: 'Quote timed out.' });
      mockGetQuote.mockImplementationOnce(async () => {
        expect(onQuoteStart).toHaveBeenCalledTimes(1);
        throw error;
      });
      const service = new TokenPlanPurchaseService({} as never);

      if (mode === 'preview') {
        await expect(
          service.preview(SELECTION, undefined, undefined, onQuoteStart),
        ).rejects.toMatchObject({ code: 'TOKENPLAN_TIMEOUT' });
      } else {
        const outcome = await service.purchase(SELECTION, {
          ...confirmInteraction(),
          onQuoteStart,
        });
        expect(outcome.error?.code).toBe('TOKENPLAN_TIMEOUT');
      }
      expect(onQuoteStart).toHaveBeenCalledTimes(1);
      expect(mockCreateOrders).not.toHaveBeenCalled();
    },
  );

  it.each(['preview', 'purchase'] as const)(
    '%s does not report quoting when eligibility checks block the flow',
    async (mode) => {
      const onQuoteStart = vi.fn();
      mockCheckAccount.mockRejectedValueOnce(
        new CliError({ code: 'TOKENPLAN_UNPAID_ORDER', message: 'An unpaid order exists.' }),
      );
      const service = new TokenPlanPurchaseService({} as never);

      if (mode === 'preview') {
        await expect(
          service.preview(SELECTION, undefined, undefined, onQuoteStart),
        ).rejects.toMatchObject({ code: 'TOKENPLAN_UNPAID_ORDER' });
      } else {
        const outcome = await service.purchase(SELECTION, {
          ...confirmInteraction(),
          onQuoteStart,
        });
        expect(outcome.error?.code).toBe('TOKENPLAN_UNPAID_ORDER');
      }
      expect(onQuoteStart).not.toHaveBeenCalled();
      expect(mockGetQuote).not.toHaveBeenCalled();
      expect(mockCreateOrders).not.toHaveBeenCalled();
    },
  );
});

describe('TokenPlanPurchaseService existing-order authorization', () => {
  it('reports the matched billing instance auto-renewal state after activation', async () => {
    const now = Date.parse('2026-09-20T09:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const apiClient = {
      callCsDataApi: vi.fn(async (options: { parse: (business: unknown) => unknown }) =>
        options.parse({
          data: {
            instanceCode: 'sub-1',
            specCode: 'standard',
            remainingDays: 30,
            startTime: now,
            endTime: now + 2_592_000_000,
            autoRenewFlag: false,
            status: 'VALID',
          },
        }),
      ),
      callFlatApi: vi.fn(async () => ({
        Success: true,
        Code: 'Success',
        Data: {
          PageNum: 1,
          PageSize: 20,
          TotalCount: 1,
          InstanceList: [
            {
              InstanceID: 'sub-1',
              ProductCode: 'sfm',
              ProductType: 'sfm_tokenplansolo_public_cn',
              Status: 'Normal',
              SubStatus: 'Normal',
              SubscriptionType: 'Subscription',
              RenewStatus: 'AutoRenewal',
              RenewalDurationUnit: 'M',
              EndTime: new Date(now + 2_592_000_000).toISOString(),
            },
          ],
        },
      })),
    };

    try {
      const outcome = await new TokenPlanPurchaseService(apiClient as never).purchase(
        { ...SELECTION, autoRenew: true },
        confirmInteraction(),
      );

      expect(outcome.result).toMatchObject({
        status: 'succeeded',
        activationStatus: 'visible',
        requestedAutoRenew: true,
        autoRenewStatus: 'enabled',
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses the pricing-page original amount for individual preview without changing settlement', async () => {
    mockGetQuote.mockResolvedValueOnce(
      makeQuote({
        amount: '396',
        tradeAmount: '396',
        originalAmount: '417',
        planAmount: '396',
        promotionDeduction: '21',
      }),
    );
    mockGetCatalogPrice.mockResolvedValueOnce({
      price: '396',
      originalPrice: '540',
      currency: 'CNY',
      monthlyCredits: null,
    });

    const value = await new TokenPlanPurchaseService({} as never).preview(SELECTION, undefined);

    expect(value.quote).toMatchObject({
      amount: '396',
      originalAmount: '540',
      planAmount: '396',
      promotionDeduction: '144',
    });
  });

  it('keeps the settlement quote usable when pricing-page original data is unavailable', async () => {
    mockGetQuote.mockResolvedValueOnce(
      makeQuote({
        amount: '396',
        tradeAmount: '396',
        originalAmount: '417',
        planAmount: '396',
        promotionDeduction: '21',
      }),
    );
    mockGetCatalogPrice.mockRejectedValueOnce(new Error('catalog temporarily unavailable'));

    const value = await new TokenPlanPurchaseService({} as never).preview(SELECTION, undefined);

    expect(value.quote).toMatchObject({
      amount: '396',
      originalAmount: '417',
      planAmount: '396',
      promotionDeduction: '21',
    });
  });

  it('requires confirmation again when displayed promotional pricing changes', async () => {
    const initial = makeQuote({
      originalAmount: '120',
      planAmount: '99',
      promotionDeduction: '21',
    });
    const changed = makeQuote({
      originalAmount: '130',
      planAmount: '99',
      promotionDeduction: '31',
    });
    mockGetQuote
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(changed);
    const interaction = confirmInteraction();

    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );

    expect(outcome.result.status).toBe('succeeded');
    expect(interaction.review).toHaveBeenCalledTimes(2);
    expect(interaction.review).toHaveBeenLastCalledWith(
      expect.objectContaining({
        changed: true,
        quote: expect.objectContaining({
          originalAmount: '130',
          planAmount: '99',
          promotionDeduction: '31',
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).toHaveBeenCalledTimes(1);
  });

  it('cash increasing after creation requires confirmation before raising the deduction', async () => {
    mockGetPaymentCapabilities
      .mockResolvedValueOnce(makeCapabilities('20'))
      .mockResolvedValueOnce(makeCapabilities('20'));
    const interaction = confirmInteraction();
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );
    expect(outcome.result.status).toBe('succeeded');
    expect(interaction.review).toHaveBeenCalledTimes(2);
    expect(interaction.review).toHaveBeenLastCalledWith(
      expect.objectContaining({
        existingOrder: expect.objectContaining({
          confirmedFundingPlan: expect.objectContaining({
            cashDeduction: '20',
            externalPayable: '79',
          }),
        }),
        fundingPlan: expect.objectContaining({ cashDeduction: '99', externalPayable: '0' }),
      }),
      expect.any(AbortSignal),
    );
    expect(mockGetOrderSettlement).toHaveBeenCalledTimes(2);
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).toHaveBeenCalledTimes(1);
    expect(mockMergePay.mock.calls[0][0].balanceDeduction).toBe('99');
  });

  it('a manually entered maximum remains manual when the balance later increases', async () => {
    mockGetPaymentCapabilities
      .mockResolvedValueOnce(makeCapabilities('20'))
      .mockResolvedValueOnce(makeCapabilities('20'));
    const interaction = confirmInteraction();
    vi.mocked(interaction.review).mockResolvedValueOnce({
      action: 'balance',
      amount: '20',
      intent: 'manual',
    });
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );
    expect(outcome.result.status).toBe('succeeded');
    expect(interaction.review).toHaveBeenCalledTimes(3);
    expect(mockMergePay.mock.calls[0][0].balanceDeduction).toBe('20');
    expect(interaction.review).toHaveBeenLastCalledWith(
      expect.objectContaining({ deductionIntent: 'manual' }),
      expect.any(AbortSignal),
    );
  });

  it('a manual deduction above the refreshed balance fails without payment', async () => {
    mockGetPaymentCapabilities
      .mockResolvedValue(makeCapabilities('20'))
      .mockResolvedValueOnce(makeCapabilities())
      .mockResolvedValueOnce(makeCapabilities());
    const interaction = confirmInteraction();
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      { ...SELECTION, balanceDeduction: '50' },
      interaction,
    );
    expect(outcome.result.status).toBe('failed');
    expect(outcome.error?.code).toBe('TOKENPLAN_BALANCE_EXCEEDED');
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('a manual deduction above the available balance fails before order creation', async () => {
    mockGetPaymentCapabilities.mockResolvedValue(makeCapabilities('10'));
    const interaction = confirmInteraction();
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      { ...SELECTION, balanceDeduction: '50' },
      interaction,
    );
    expect(outcome.result.status).toBe('failed');
    expect(outcome.error?.code).toBe('TOKENPLAN_BALANCE_EXCEEDED');
    expect(interaction.review).not.toHaveBeenCalled();
    expect(mockCreateOrders).not.toHaveBeenCalled();
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('a fully covering coupon cannot hide a manual deduction above the available balance', async () => {
    mockGetQuote.mockResolvedValue(
      makeQuote({ amount: '0', tradeAmount: '0', couponDeduction: '99' }),
    );
    mockGetPaymentCapabilities.mockResolvedValue(makeCapabilities('10'));
    mockGetOrderSettlement.mockResolvedValue({
      settledPayable: '0',
      orderId: 'PAY-001',
      currency: 'CNY',
    });
    const interaction = confirmInteraction();
    const service = new TokenPlanPurchaseService({} as never);
    const selection = { ...SELECTION, balanceDeduction: '10.01' };
    await expect(service.preview(selection, undefined)).rejects.toMatchObject({
      code: 'TOKENPLAN_BALANCE_EXCEEDED',
      exitCode: 4,
    });
    const outcome = await service.purchase(selection, interaction);
    expect(outcome.result.status).toBe('failed');
    expect(outcome.error?.code).toBe('TOKENPLAN_BALANCE_EXCEEDED');
    expect(outcome.exitCode).toBe(4);
    expect(interaction.review).not.toHaveBeenCalled();
    expect(mockCreateOrders).not.toHaveBeenCalled();
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('a fully covering coupon still applies zero balance when the manual amount is available', async () => {
    mockGetQuote.mockResolvedValue(
      makeQuote({ amount: '0', tradeAmount: '0', couponDeduction: '99' }),
    );
    mockGetPaymentCapabilities.mockResolvedValue(makeCapabilities('10'));
    mockGetOrderSettlement.mockResolvedValue({
      settledPayable: '0',
      orderId: 'PAY-001',
      currency: 'CNY',
    });
    const service = new TokenPlanPurchaseService({} as never);
    const selection = { ...SELECTION, balanceDeduction: '10' };
    const preview = await service.preview(selection, undefined);
    expect(preview.deductionIntent).toBe('none');
    expect(preview.fundingPlan?.deductionIntent).toBe('none');
    const outcome = await service.purchase(selection, confirmInteraction());
    expect(outcome.result.status).toBe('succeeded');
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '0', balanceDeduction: '0' }),
    );
  });

  it.each(['unknown', 'no-scanning'] as const)(
    'post-order %s stops before MergePay',
    async (mode) => {
      mockGetPaymentCapabilities
        .mockResolvedValueOnce(makeCapabilities('10'))
        .mockResolvedValueOnce(makeCapabilities('10'))
        .mockResolvedValueOnce({
          ...makeCapabilities('10'),
          admissionResult: mode === 'unknown' ? 'unknown' : 'supported',
          alipayScanning: mode !== 'no-scanning',
        });
      const outcome = await new TokenPlanPurchaseService({} as never).purchase(
        SELECTION,
        confirmInteraction(),
      );
      expect(outcome.result).toMatchObject({
        stage: 'create',
        status: 'failed',
        paymentAttempted: false,
        paymentOrderId: 'PAY-001',
      });
      expect(outcome.exitCode).toBe(1);
      expect(mockMergePay).not.toHaveBeenCalled();
    },
  );

  it('cancelling an existing-order review preserves the order without pretending a write is unknown', async () => {
    mockGetOrderSettlement.mockResolvedValue({
      settledPayable: '130',
      orderId: 'PAY-001',
      currency: 'CNY',
    });
    const interaction = confirmInteraction();
    vi.mocked(interaction.review)
      .mockResolvedValueOnce({ action: 'confirm' })
      .mockResolvedValueOnce({ action: 'cancel' });
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );
    expect(outcome.result).toMatchObject({
      stage: 'create',
      status: 'cancelled',
      paymentAttempted: false,
      paymentOrderId: 'PAY-001',
    });
    expect(outcome.exitCode).toBe(0);
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('SIGINT after a known creation but before payment returns cancelled / 130', async () => {
    const controller = new AbortController();
    mockCreateOrders.mockImplementationOnce(async () => {
      controller.abort();
      return { paymentOrderId: 'PAY-001', orderIds: ['ORD-001'] };
    });
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      confirmInteraction(),
      controller.signal,
    );
    expect(outcome.result).toMatchObject({
      stage: 'create',
      status: 'cancelled',
      paymentAttempted: false,
      paymentOrderId: 'PAY-001',
    });
    expect(outcome.exitCode).toBe(130);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('continuous settlement drift is bounded and never repeats Create or calls MergePay', async () => {
    let amount = 100;
    mockGetOrderSettlement.mockImplementation(async () => ({
      settledPayable: String(amount++),
      orderId: 'PAY-001',
      currency: 'CNY',
    }));
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      confirmInteraction(),
    );
    expect(outcome.error?.code).toBe('TOKENPLAN_SETTLEMENT_UNSTABLE');
    expect(outcome.result.status).toBe('failed');
    expect(mockGetOrderSettlement).toHaveBeenCalledTimes(20);
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('coupon changes are rejected after creation without rebuilding an order', async () => {
    mockGetOrderSettlement.mockResolvedValue({
      settledPayable: '80',
      orderId: 'PAY-001',
      currency: 'CNY',
    });
    const interaction = confirmInteraction();
    vi.mocked(interaction.review)
      .mockResolvedValueOnce({ action: 'confirm' })
      .mockResolvedValueOnce({ action: 'coupon', coupon: 'other' });
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );
    expect(outcome.error?.code).toBe('TOKENPLAN_ORDER_ALREADY_CREATED');
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('all created order IDs are passed to settlement verification', async () => {
    mockCreateOrders.mockResolvedValueOnce({
      paymentOrderId: 'PAY-001',
      orderIds: ['PAY-001', 'PAY-002'],
    });
    await new TokenPlanPurchaseService({} as never).purchase(
      { ...SELECTION, edition: 'team' },
      confirmInteraction(),
    );
    expect(mockGetOrderSettlement).toHaveBeenCalledWith('PAY-001', expect.any(AbortSignal), [
      'PAY-001',
      'PAY-002',
    ]);
  });

  it('an uncertain payment write remains unknown and is never retried', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      throw new Error('network timeout');
    });
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      confirmInteraction(),
    );
    expect(outcome.result).toMatchObject({
      stage: 'payment',
      status: 'unknown',
      paymentAttempted: true,
    });
    expect(outcome.exitCode).toBe(8);
    expect(mockMergePay).toHaveBeenCalledTimes(1);
  });

  it('a confirmed payment survives a subsequent UI exception', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      return { status: 'pending', url: null };
    });
    const interaction = confirmInteraction();
    vi.mocked(interaction.payment).mockImplementationOnce(async (_url, wait) => {
      await wait;
      throw new Error('display failed');
    });
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );
    expect(outcome.result).toMatchObject({
      status: 'succeeded',
      activationStatus: 'pending',
      paymentAttempted: true,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.warning).toContain('follow-up display or activation check');
    expect(outcome.error).toBeUndefined();
  });

  it('keeps a confirmed pending payment incomplete when payment display fails', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      return { status: 'pending', url: null };
    });
    mockWaitForPaymentResult.mockReturnValueOnce(new Promise(() => {}));
    const interaction = confirmInteraction();
    vi.mocked(interaction.payment).mockRejectedValueOnce(new Error('display failed'));

    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );

    expect(outcome.result).toMatchObject({
      status: 'pending',
      paymentAttempted: true,
    });
    expect(outcome.exitCode).toBe(8);
    expect(outcome.error?.code).toBe('TOKENPLAN_PAYMENT_INCOMPLETE');
    expect(outcome.error?.message).toContain('do not pay again');
  });

  it('points payment timeout recovery to the unpaid subscription page', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      return { status: 'pending', url: null };
    });
    mockWaitForPaymentResult.mockResolvedValueOnce({
      orderId: 'PAY-001',
      status: 'timed_out',
      reason: 'payment_wait_expired',
    });

    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      confirmInteraction(),
    );

    expect(outcome.error?.code).toBe('TOKENPLAN_PAYMENT_INCOMPLETE');
    expect(outcome.error?.message).toContain('/home/billing/subscription');
    expect(outcome.error?.message).not.toContain('/home/billing/orders');
  });

  it('preserves an order-list-confirmed cancellation as a terminal purchase result', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      return { status: 'pending', url: null };
    });
    mockWaitForPaymentResult.mockResolvedValueOnce({
      orderId: 'PAY-001',
      status: 'cancelled',
      reason: 'order_cancelled',
    });

    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      confirmInteraction(),
    );

    expect(outcome.result).toMatchObject({
      stage: 'payment',
      status: 'cancelled',
      reason: 'order_cancelled',
      paymentOrderId: 'PAY-001',
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.error).toBeUndefined();
  });

  it('skipPolling does not overwrite a terminal result already returned by the poller', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      return { status: 'pending', url: null };
    });
    const interaction = confirmInteraction();
    vi.mocked(interaction.payment).mockImplementationOnce(async (_url, wait) => {
      await wait;
      return { skipPolling: true };
    });
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );
    expect(outcome.result.status).toBe('succeeded');
    expect(outcome.exitCode).toBe(0);
  });

  it('skipPolling returns task-not-completed while payment remains pending', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      return { status: 'pending', url: null };
    });
    mockWaitForPaymentResult.mockReturnValueOnce(new Promise(() => {}));
    const interaction = confirmInteraction();
    vi.mocked(interaction.payment).mockResolvedValueOnce({ skipPolling: true });

    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      interaction,
    );

    expect(outcome.result.status).toBe('pending');
    expect(outcome.exitCode).toBe(8);
    expect(outcome.error).toBeUndefined();
    expect(interaction.payment).toHaveBeenCalledWith(
      null,
      expect.any(Promise),
      expect.objectContaining({
        expiresAt: expect.any(Number),
        details: {
          paymentOrderId: 'PAY-001',
          type: 'token_plan_individual_standard',
          billingCycle: 'monthly',
          payableAmount: '0',
        },
      }),
    );
  });

  it('preview normalizes remote failures and removes verbose backend details', async () => {
    mockGetCommodity.mockRejectedValueOnce(new Error('private backend response body'));

    const failure = await new TokenPlanPurchaseService({} as never)
      .preview(SELECTION, undefined)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'SUBSCRIPTION_SERVICE_UNAVAILABLE',
      message: 'Token Plan preview could not be loaded. Try again later.',
      detail: undefined,
    });
    expect(String(failure)).not.toContain('private backend response body');
  });

  it.each(['preview', 'purchase'] as const)(
    '%s preserves active-subscription guidance and stops before quote or Create',
    async (mode) => {
      const message =
        'An active Token Plan subscription already exists for this edition. View subscription: https://platform.qianwenai.com/home/analytics/token-plan/individual';
      mockCheckAccount.mockRejectedValueOnce(
        new CliError({
          code: 'TOKENPLAN_ACTIVE_SUBSCRIPTION',
          message,
          exitCode: 1,
        }),
      );
      const service = new TokenPlanPurchaseService({} as never);

      const failure =
        mode === 'preview'
          ? await service.preview(SELECTION, undefined).catch((error: unknown) => error)
          : (await service.purchase(SELECTION, confirmInteraction())).error;

      expect(failure).toMatchObject({
        code: 'TOKENPLAN_ACTIVE_SUBSCRIPTION',
        message,
        exitCode: 1,
      });
      expect(mockGetQuote).not.toHaveBeenCalled();
      expect(mockCreateOrders).not.toHaveBeenCalled();
      expect(mockMergePay).not.toHaveBeenCalled();
    },
  );

  it.each(['preview', 'purchase'] as const)(
    '%s preserves the arrears error and stops before quote, Create or MergePay',
    async (mode) => {
      const message =
        "Your account balance is below 0. Run 'qianwen billing balance recharge' to recharge before purchasing a Token Plan.";
      mockCheckAccount.mockRejectedValueOnce(
        new CliError({
          code: 'TOKENPLAN_ACCOUNT_IN_ARREARS',
          message,
          exitCode: 1,
        }),
      );
      const service = new TokenPlanPurchaseService({} as never);

      const failure =
        mode === 'preview'
          ? await service.preview(SELECTION, undefined).catch((error: unknown) => error)
          : (await service.purchase(SELECTION, confirmInteraction())).error;

      expect(failure).toMatchObject({
        code: 'TOKENPLAN_ACCOUNT_IN_ARREARS',
        message,
        exitCode: 1,
      });
      expect(mockGetQuote).not.toHaveBeenCalled();
      expect(mockCreateOrders).not.toHaveBeenCalled();
      expect(mockMergePay).not.toHaveBeenCalled();
    },
  );

  it('rechecks arrears after confirmation and stops immediately before Create', async () => {
    const message =
      "Your account balance is below 0. Run 'qianwen billing balance recharge' to recharge before purchasing a Token Plan.";
    mockCheckAccount.mockResolvedValueOnce(undefined).mockRejectedValueOnce(
      new CliError({
        code: 'TOKENPLAN_ACCOUNT_IN_ARREARS',
        message,
        exitCode: 1,
      }),
    );

    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      confirmInteraction(),
    );

    expect(outcome.error).toMatchObject({
      code: 'TOKENPLAN_ACCOUNT_IN_ARREARS',
      message,
      exitCode: 1,
    });
    expect(mockCheckAccount).toHaveBeenCalledTimes(2);
    expect(mockGetQuote).toHaveBeenCalledTimes(2);
    expect(mockCreateOrders).not.toHaveBeenCalled();
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('keeps paymentAttempted false when MergePay fails before transport starts', async () => {
    mockMergePay.mockRejectedValueOnce(new Error('local request construction failed'));
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      confirmInteraction(),
    );
    expect(outcome.result).toMatchObject({
      stage: 'payment',
      status: 'failed',
      paymentAttempted: false,
    });
    expect(outcome.exitCode).toBe(1);
  });
});

describe('TokenPlanPurchaseService balance deduction flow', () => {
  it('auto deduction (balanceDeduction=null) uses max available balance', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase({ ...SELECTION, balanceDeduction: null }, interaction);

    expect(outcome.result.status).toBe('succeeded');
    // mergePay should be called with cashDeduction matching min(available, order)
    expect(mockMergePay).toHaveBeenCalledTimes(1);
    const mergeInput = mockMergePay.mock.calls[0][0];
    expect(mergeInput.balanceDeduction).toBe('99');
  });

  it('manual deduction (balanceDeduction="50.00") uses specified amount', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase(
      { ...SELECTION, balanceDeduction: '50.00' },
      interaction,
    );

    expect(outcome.result.status).toBe('succeeded');
    expect(mockMergePay).toHaveBeenCalledTimes(1);
    const mergeInput = mockMergePay.mock.calls[0][0];
    expect(mergeInput.balanceDeduction).toBe('50');
  });

  it('disabled deduction (balanceDeduction="0") yields cashDeduction=0', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase({ ...SELECTION, balanceDeduction: '0' }, interaction);

    expect(outcome.result.status).toBe('succeeded');
    expect(mockMergePay).toHaveBeenCalledTimes(1);
    const mergeInput = mockMergePay.mock.calls[0][0];
    expect(mergeInput.balanceDeduction).toBe('0');
  });

  it('settlement changes require existing-order confirmation and another verification', async () => {
    // Settlement returns a different amount than the quote
    mockGetOrderSettlement.mockResolvedValue({
      settledPayable: '80.00',
      orderId: 'PAY-001',
      currency: 'CNY',
    });

    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase({ ...SELECTION, balanceDeduction: null }, interaction);

    expect(outcome.result.status).toBe('succeeded');
    expect(mockMergePay).toHaveBeenCalledTimes(1);
    const mergeInput = mockMergePay.mock.calls[0][0];
    // With auto deduction on settlement=80, available=200 → cashDeduction=80
    expect(mergeInput.amount).toBe('80');
    expect(mergeInput.balanceDeduction).toBe('80');
    // settledAmount should be recorded when plan fingerprint differs
    expect(outcome.result.settledAmount).toBe('80.00');
    expect(outcome.result.amount).toBe('99.00');
    expect(interaction.review).toHaveBeenCalledTimes(2);
    expect(interaction.review).toHaveBeenLastCalledWith(
      expect.objectContaining({
        existingOrder: expect.objectContaining({
          paymentOrderId: 'PAY-001',
          orderIds: ['ORD-001'],
        }),
        fundingPlan: expect.objectContaining({ orderPayable: '80', cashDeduction: '80' }),
      }),
      expect.any(AbortSignal),
    );
    expect(mockGetOrderSettlement).toHaveBeenCalledTimes(2);
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
  });

  it('full cash deduction → externalPayable=0', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase({ ...SELECTION, balanceDeduction: null }, interaction);

    expect(outcome.result.status).toBe('succeeded');
    expect(outcome.result.externalPayable).toBe('0');
    expect(outcome.result.cashDeduction).toBe('99');
    expect(outcome.result.paymentMode).toBe('cash_alipay');
  });

  it('post-order credit control blocks payment and preserves the existing order', async () => {
    mockGetPaymentCapabilities
      .mockResolvedValueOnce(makeCapabilities())
      .mockResolvedValueOnce(makeCapabilities())
      .mockRejectedValueOnce(
        new CliError({
          code: 'TOKENPLAN_CREDIT_NOT_SUPPORTED',
          message: 'Credit payment is unsupported.',
          exitCode: 1,
        }),
      );

    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase({ ...SELECTION, balanceDeduction: null }, interaction);

    expect(outcome.result.status).toBe('failed');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.paymentOrderId).toBe('PAY-001');
    expect(outcome.result.paymentAttempted).toBe(false);
    expect(outcome.error?.code).toBe('TOKENPLAN_CREDIT_NOT_SUPPORTED');
    expect(outcome.error?.message).toContain('/home/billing/subscription');
    expect(outcome.error?.message).not.toContain('/home/billing/orders');
    expect(outcome.error?.message).not.toContain('/checkout');
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('post-order settlement failure never falls back to a stale payment plan', async () => {
    mockGetOrderSettlement.mockRejectedValue(new Error('network timeout'));

    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase({ ...SELECTION, balanceDeduction: null }, interaction);

    expect(outcome.result.status).toBe('failed');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.paymentOrderId).toBe('PAY-001');
    expect(outcome.result.stage).toBe('create');
    expect(outcome.result.paymentAttempted).toBe(false);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('order creation throws NO_REAL_NAME_AUTHENTICATION → TOKENPLAN_REAL_NAME_REQUIRED exitCode=1', async () => {
    mockCreateOrders.mockRejectedValue(
      new CliError({
        code: 'TOKENPLAN_REAL_NAME_REQUIRED',
        message:
          'Real-name authentication is required. Complete it at: https://platform.qianwenai.com/home/settings/account',
        exitCode: 1,
      }),
    );

    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase({ ...SELECTION, balanceDeduction: null }, interaction);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.error).toBeInstanceOf(CliError);
    expect(outcome.error?.code).toBe('TOKENPLAN_REAL_NAME_REQUIRED');
    expect(outcome.error?.message).toContain(
      'https://platform.qianwenai.com/home/settings/account',
    );
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.paymentOrderId).toBeNull();
  });

  it('individual credit account blocked → error message points to Token Plan pricing', async () => {
    mockGetPaymentCapabilities.mockRejectedValue(
      new CliError({
        code: 'TOKENPLAN_CREDIT_NOT_SUPPORTED',
        message:
          'Your account uses credit-based payment, which the CLI does not support. Purchase at: https://platform.qianwenai.com/pricing/token-plan',
        exitCode: 1,
      }),
    );

    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase(
      { ...SELECTION, type: 'token_plan_individual_lite' },
      interaction,
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.error?.code).toBe('TOKENPLAN_CREDIT_NOT_SUPPORTED');
    expect(outcome.error?.message).toContain('https://platform.qianwenai.com/pricing/token-plan');
    expect(outcome.error?.message).not.toContain('/checkout');
    expect(outcome.error?.message).not.toContain('https://www.qianwenai.com');
    expect(outcome.result.paymentOrderId).toBeNull();
  });

  it('alipayScanning=false + externalPayable>0 → throws TOKENPLAN_ALIPAY_SCANNING_UNAVAILABLE', async () => {
    // Return capabilities where alipayScanning is false and balance is insufficient for full deduction
    mockGetPaymentCapabilities.mockImplementation(async () => ({
      admissionResult: 'supported',
      cashMethod: { available: '10.00', currency: 'CNY' },
      alipayScanning: false,
      identityContext: { site: 'china-site', nbid: 'nb-123' },
    }));

    const service = new TokenPlanPurchaseService({} as never);

    await expect(
      service.preview({ ...SELECTION, balanceDeduction: null }, undefined),
    ).rejects.toMatchObject({
      code: 'TOKENPLAN_ALIPAY_SCANNING_UNAVAILABLE',
      message:
        'Your account does not support Alipay QR payment. Use full cash balance deduction or continue on the unpaid orders page: https://platform.qianwenai.com/home/billing/subscription',
    });
  });

  it('alipayScanning=false + full cash deduction → passes normally', async () => {
    // Balance >= order amount → full cash deduction, externalPayable = 0
    mockGetPaymentCapabilities.mockImplementation(async () => ({
      admissionResult: 'supported',
      cashMethod: { available: '200.00', currency: 'CNY' },
      alipayScanning: false,
      identityContext: { site: 'china-site', nbid: 'nb-123' },
    }));

    const service = new TokenPlanPurchaseService({} as never);

    const result = await service.preview({ ...SELECTION, balanceDeduction: null }, undefined);
    expect(result.externalPayable).toBe('0');
    expect(result.fundingPlan?.externalPayable).toBe('0');
  });

  it('team credit account blocked → error message points to Token Plan pricing', async () => {
    mockGetPaymentCapabilities.mockRejectedValue(
      new CliError({
        code: 'TOKENPLAN_CREDIT_NOT_SUPPORTED',
        message:
          'Your account uses credit-based payment, which the CLI does not support. Purchase at: https://platform.qianwenai.com/pricing/token-plan',
        exitCode: 1,
      }),
    );

    const service = new TokenPlanPurchaseService({} as never);
    const interaction = confirmInteraction();

    const outcome = await service.purchase(
      {
        ...SELECTION,
        type: 'token_plan_team',
        edition: 'team',
        billingCycle: 'yearly',
        seats: [
          { specCode: 'standard', quantity: 2 },
          { specCode: 'pro', quantity: 1 },
        ],
      },
      interaction,
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.error?.code).toBe('TOKENPLAN_CREDIT_NOT_SUPPORTED');
    expect(outcome.error?.message).toContain('https://platform.qianwenai.com/pricing/token-plan');
    expect(outcome.error?.message).not.toContain('/checkout');
  });
});
