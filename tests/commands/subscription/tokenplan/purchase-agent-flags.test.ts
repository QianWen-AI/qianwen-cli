/** Unit tests for purchase command agent-friendly flags: --preview, --coupon, --confirm, --no-coupon, --preview-amount */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import type {
  TokenPlanQuote,
  TokenPlanSelection,
} from '../../../../src/types/tokenplan-purchase.js';
import type {
  CashPaymentCapabilities,
  TokenPlanMergePayInput,
} from '../../../../src/types/tokenplan-payment.js';
import type {
  TokenPlanPurchaseDecision,
  TokenPlanPurchaseInteraction,
} from '../../../../src/services/tokenplan-purchase-service.js';

// ---------------------------------------------------------------------------
// Module mocks — control the sub-services from outside
// ---------------------------------------------------------------------------

const mockGetCommodity = vi.fn();
const mockGetQuote = vi.fn();
const mockCheckInventory = vi.fn();

vi.mock('../../../../src/services/tokenplan-trade-service.js', () => ({
  TokenPlanTradeService: class {
    getCommodity = mockGetCommodity;
    getQuote = mockGetQuote;
    checkInventory = mockCheckInventory;
  },
}));

const mockCheckAccount = vi.fn();
const mockGetPaymentCapabilities = vi.fn();

vi.mock('../../../../src/services/tokenplan-purchase-gates.js', () => ({
  TokenPlanPurchaseGates: class {
    checkAccount = mockCheckAccount;
    getPaymentCapabilities = mockGetPaymentCapabilities;
  },
}));

const mockCreateOrders = vi.fn();
const mockMergePay = vi.fn();
const mockGetOrderSettlement = vi.fn();
const mockWaitForPaymentResult = vi.fn();

vi.mock('../../../../src/services/tokenplan-payment-service.js', () => ({
  PAYMENT_POLL_TIMEOUT_MS: 60_000,
  TokenPlanPaymentService: class {
    createOrders = mockCreateOrders;
    mergePay = (input: TokenPlanMergePayInput) => mockMergePay(input);
    getOrderSettlement = mockGetOrderSettlement;
    waitForPaymentResult = mockWaitForPaymentResult;
  },
}));

vi.mock('../../../../src/services/tokenplan-configuration.js', () => ({
  buildTokenPlanConfigurations: () => [{ commodityCode: 'test', specCode: 'standard' }],
  tokenPlanCommodityCode: () => 'sfm_tokenplanpersonal_dp_cn',
}));

vi.mock('../../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: vi.fn(),
}));

vi.mock('../../../../src/services/index.js', () => ({
  createServices: () => ({ tokenPlanPurchaseService: new TokenPlanPurchaseService({} as never) }),
}));

vi.mock('../../../../src/config/manager.js', () => ({
  getEffectiveConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../../src/output/format.js', () => ({
  resolveFormatFromCommand: vi.fn().mockReturnValue('json'),
  outputJSON: vi.fn(),
}));

vi.mock('../../../../src/utils/command-interrupt.js', () => ({
  registerCommandInterrupt: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../../../../src/ui/TokenPlanPurchase.js', () => ({
  createTokenPlanPurchaseInteraction: vi.fn(),
  renderTokenPlanPurchaseResult: vi.fn(),
}));

vi.mock('../../../../src/output/text/tokenplan-purchase.js', () => ({
  renderTextTokenPlanPurchase: vi.fn(),
}));

vi.mock('../../../../src/view-models/subscription/tokenplan-purchase.js', () => ({
  buildTokenPlanPurchaseResult: vi.fn().mockReturnValue({ data: {} }),
}));

vi.mock('../../../../src/services/tokenplan-deadline.js', () => ({
  withTokenPlanDeadline: (operation: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    return operation(controller.signal);
  },
  tokenPlanSleep: () => Promise.resolve(),
}));

// Import after mocks are set up
const { TokenPlanPurchaseService } =
  await import('../../../../src/services/tokenplan-purchase-service.js');
const {
  parseTokenPlanSelection,
  createAutoConfirmInteraction,
  subscriptionTokenPlanPurchaseAction,
} = await import('../../../../src/commands/subscription/tokenplan/purchase.js');
const { registerSubscriptionTokenPlanCommands } =
  await import('../../../../src/commands/subscription/tokenplan/index.js');
const { ensureAuthenticated } = await import('../../../../src/auth/credentials.js');
const { NO_TOKENPLAN_COUPON } = await import('../../../../src/api/parsers/tokenplan-trade.js');
const { getEffectiveConfig } = await import('../../../../src/config/manager.js');
const { resolveFormatFromCommand } = await import('../../../../src/output/format.js');
const { outputJSON } = await import('../../../../src/output/format.js');
const { registerCommandInterrupt } = await import('../../../../src/utils/command-interrupt.js');
const { buildTokenPlanPurchaseResult } =
  await import('../../../../src/view-models/subscription/tokenplan-purchase.js');
const { createTokenPlanPurchaseInteraction } =
  await import('../../../../src/ui/TokenPlanPurchase.js');

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
    amount: '39.00',
    tradeAmount: '39.00',
    currency: 'CNY',
    coupon: 'default',
    coupons: [
      { id: 'coupon_001', name: '满100减10', balance: '10.00', recommended: true },
      { id: 'coupon_002', name: '新人券', faceValue: '50.00', validUntil: '2026-12-31' },
    ],
    originalAmount: '39.00',
    planAmount: '39.00',
    promotionDeduction: '0',
    couponDeduction: '0',
    ...overrides,
  };
}

function makeCapabilities(available = '50.00'): CashPaymentCapabilities {
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
  vi.mocked(getEffectiveConfig).mockReturnValue({} as never);
  vi.mocked(resolveFormatFromCommand).mockReturnValue('json');
  vi.mocked(registerCommandInterrupt).mockReturnValue(() => {});
  vi.mocked(buildTokenPlanPurchaseResult).mockReturnValue({ data: {} } as never);
  mockGetCommodity.mockResolvedValue({ commodityCode: 'test' });
  mockGetQuote.mockImplementation(async () => makeQuote());
  mockCheckInventory.mockResolvedValue(undefined);
  mockCheckAccount.mockResolvedValue(undefined);
  mockGetPaymentCapabilities.mockImplementation(async () => makeCapabilities());
  mockCreateOrders.mockResolvedValue({
    paymentOrderId: 'PAY-001',
    orderIds: ['ORD-001'],
  });
  mockGetOrderSettlement.mockResolvedValue({
    settledPayable: '39.00',
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
// Tests: preview mode
// ---------------------------------------------------------------------------

describe('purchase quote progress output', () => {
  it.each([
    ['interactive', 'table', 3],
    ['interactive', 'text', 3],
    ['interactive', 'json', 3],
    ['preview', 'json', 1],
    ['confirm', 'json', 2],
  ] as const)(
    '%s / %s reports progress before each quote and keeps JSON stdout clean',
    async (mode, format, count) => {
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      vi.mocked(resolveFormatFromCommand).mockReturnValue(format);
      const interaction = confirmInteraction();
      vi.mocked(interaction.review)
        .mockResolvedValueOnce({ action: 'coupon', coupon: 'coupon_002' })
        .mockResolvedValueOnce({ action: 'balance', amount: '5' });
      if (mode === 'interactive') {
        vi.mocked(createTokenPlanPurchaseInteraction).mockReturnValueOnce(interaction);
      }
      const notice = 'Preparing Token Plan quote...\n';
      const progress = format === 'json' ? stderr : stdout;
      mockGetQuote.mockImplementation(async (_configurations, coupon: string) => {
        expect(progress.mock.calls.map(([value]) => value)).toEqual(
          Array(mockGetQuote.mock.calls.length).fill(notice),
        );
        return makeQuote({ coupon });
      });
      if (format === 'json') {
        vi.mocked(outputJSON).mockImplementationOnce((value) => {
          process.stdout.write(`${JSON.stringify(value)}\n`);
        });
      }
      const cmd = {
        opts: () => ({
          billingCycle: 'monthly',
          channel: 'alipay',
          autoRenew: false,
          ...(mode === 'preview' ? { preview: true } : {}),
          ...(mode === 'confirm'
            ? { confirm: true, coupon: 'default', balanceDeduction: '0', previewAmount: '39.00' }
            : {}),
        }),
        parent: null,
      } as never;

      try {
        await subscriptionTokenPlanPurchaseAction(cmd).call(cmd, SELECTION.type);

        expect(mockGetQuote).toHaveBeenCalledTimes(count);
        expect(progress.mock.calls.map(([value]) => value)).toEqual(Array(count).fill(notice));
        if (format === 'json') {
          expect(stdout).toHaveBeenCalledTimes(1);
          expect(() => JSON.parse(String(stdout.mock.calls[0][0]))).not.toThrow();
        } else {
          expect(stderr).not.toHaveBeenCalled();
        }
        expect(mockCreateOrders).toHaveBeenCalledTimes(mode === 'preview' ? 0 : 1);
      } finally {
        if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
        else Reflect.deleteProperty(process.stdin, 'isTTY');
        if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
        else Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    },
  );
});

describe('TokenPlanPurchaseService.preview()', () => {
  it('preview returns the TokenPlanPurchasePreview shape', async () => {
    const service = new TokenPlanPurchaseService({} as never);

    const result = await service.preview(SELECTION, undefined);

    expect(result.selection).toEqual(SELECTION);
    expect(result.quote.amount).toBe('39.00');
    expect(result.quote.coupons).toHaveLength(2);
    expect(result.balance).toBeDefined();
    expect(result.maxDeduction).toBeDefined();
    expect(result.capabilities.admissionResult).toBe('supported');
    expect(result.fundingPlan?.paymentMode).toBe('cash_alipay');
  });

  it('preview rejects excessive explicit balance deductions without creating an order', async () => {
    const service = new TokenPlanPurchaseService({} as never);

    await service.preview(SELECTION, undefined);

    expect(mockCreateOrders).not.toHaveBeenCalled();
    expect(mockMergePay).not.toHaveBeenCalled();

    mockGetPaymentCapabilities.mockResolvedValue(makeCapabilities('10'));
    await expect(
      service.preview({ ...SELECTION, balanceDeduction: '10.01' }, undefined),
    ).rejects.toMatchObject({ code: 'TOKENPLAN_BALANCE_EXCEEDED' });
    expect(mockCreateOrders).not.toHaveBeenCalled();
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('preview forwards the selected couponId to quote', async () => {
    const service = new TokenPlanPurchaseService({} as never);

    await service.preview(SELECTION, 'coupon_001');

    expect(mockGetQuote).toHaveBeenCalled();
    // The coupon parameter is passed to getQuote
    const quoteArgs = mockGetQuote.mock.calls[0];
    expect(quoteArgs[1]).toBe('coupon_001');
  });

  it('preview uses the default coupon selection when omitted', async () => {
    const service = new TokenPlanPurchaseService({} as never);

    await service.preview(SELECTION, undefined);

    const quoteArgs = mockGetQuote.mock.calls[0];
    expect(quoteArgs[1]).toBe('default');
  });

  it('keeps automatic deduction intent consistent when a coupon covers the full price', async () => {
    mockGetQuote.mockResolvedValue(
      makeQuote({ amount: '0', tradeAmount: '0', couponDeduction: '39' }),
    );
    const program = new Command().exitOverride();
    registerSubscriptionTokenPlanCommands(program);

    await program.parseAsync(
      [
        'tokenplan',
        'purchase',
        SELECTION.type,
        '--billing-cycle',
        'monthly',
        '--channel',
        'alipay',
        '--no-auto-renew',
        '--preview',
      ],
      { from: 'user' },
    );

    expect(outputJSON).toHaveBeenLastCalledWith(
      expect.objectContaining({
        orderAmount: '0',
        deductionIntent: 'auto',
        fundingPlan: expect.objectContaining({
          deductionIntent: 'auto',
          cashDeduction: '0',
          externalPayable: '0',
        }),
      }),
    );
    expect(mockCreateOrders).not.toHaveBeenCalled();
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('--preview parses all three team seat tiers and reports list price, sale price, coupon deduction, and payable amount', async () => {
    const preview = vi.spyOn(TokenPlanPurchaseService.prototype, 'preview');
    mockGetQuote.mockResolvedValueOnce(
      makeQuote({
        amount: '0',
        tradeAmount: '0',
        originalAmount: '198',
        planAmount: '150',
        promotionDeduction: '48',
        couponDeduction: '150',
      }),
    );
    const program = new Command().exitOverride();
    registerSubscriptionTokenPlanCommands(program);

    await program.parseAsync(
      [
        'tokenplan',
        'purchase',
        'token_plan_team',
        '--billing-cycle',
        'monthly',
        '--channel',
        'alipay',
        '--standard-seat-count',
        '1',
        '--pro-seat-count',
        '2',
        '--max-seat-count',
        '3',
        '--no-auto-renew',
        '--preview',
      ],
      { from: 'user' },
    );

    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        edition: 'team',
        seats: [
          { specCode: 'standard', quantity: 1 },
          { specCode: 'pro', quantity: 2 },
          { specCode: 'max', quantity: 3 },
        ],
      }),
      undefined,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(outputJSON).toHaveBeenLastCalledWith(
      expect.objectContaining({
        originalAmount: '198',
        planAmount: '150',
        promotionDeduction: '48',
        couponDeduction: '150',
        orderAmount: '0',
        autoRenew: false,
      }),
    );
  });

  it('forwards an explicit --auto-renew selection', async () => {
    const program = new Command().exitOverride();
    registerSubscriptionTokenPlanCommands(program);

    await program.parseAsync(
      [
        'tokenplan',
        'purchase',
        SELECTION.type,
        '--billing-cycle',
        'monthly',
        '--channel',
        'alipay',
        '--auto-renew',
        '--preview',
      ],
      { from: 'user' },
    );

    expect(outputJSON).toHaveBeenLastCalledWith(expect.objectContaining({ autoRenew: true }));
    expect(mockCreateOrders).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: createAutoConfirmInteraction
// ---------------------------------------------------------------------------

describe('createAutoConfirmInteraction()', () => {
  it('confirms directly when couponId is omitted', async () => {
    const interaction = createAutoConfirmInteraction();

    const preview = {
      selection: SELECTION,
      quote: makeQuote(),
      balance: '50.00',
      maxDeduction: '39.00',
      balanceDeduction: '39.00',
      externalPayable: '0',
      deductionValid: true,
      changed: false,
      capabilities: makeCapabilities(),
      deductionIntent: 'auto' as const,
      fundingPlan: {
        paymentMode: 'cash_alipay' as const,
        deductionIntent: 'auto' as const,
        orderPayable: '39.00',
        cashDeduction: '39.00',
        externalPayable: '0',
      },
    };

    const decision = await interaction.review(preview);
    expect(decision).toEqual({ action: 'confirm' });
  });

  it('selects the requested coupon before confirming when it differs from the current coupon', async () => {
    const interaction = createAutoConfirmInteraction('coupon_002');

    const preview = {
      selection: SELECTION,
      quote: makeQuote({ coupon: 'default' }),
      balance: '50.00',
      maxDeduction: '39.00',
      balanceDeduction: '39.00',
      externalPayable: '0',
      deductionValid: true,
      changed: false,
      capabilities: makeCapabilities(),
      deductionIntent: 'auto' as const,
      fundingPlan: {
        paymentMode: 'cash_alipay' as const,
        deductionIntent: 'auto' as const,
        orderPayable: '39.00',
        cashDeduction: '39.00',
        externalPayable: '0',
      },
    };

    // First call: switch coupon
    const decision1 = await interaction.review(preview);
    expect(decision1).toEqual({ action: 'coupon', coupon: 'coupon_002' });

    // Second call: now coupon matches → confirm
    const previewWithCoupon = {
      ...preview,
      quote: makeQuote({ coupon: 'coupon_002' }),
    };
    const decision2 = await interaction.review(previewWithCoupon);
    expect(decision2).toEqual({ action: 'confirm' });
  });

  it('confirms directly when the requested coupon is already selected', async () => {
    const interaction = createAutoConfirmInteraction('default');

    const preview = {
      selection: SELECTION,
      quote: makeQuote({ coupon: 'default' }),
      balance: '50.00',
      maxDeduction: '39.00',
      balanceDeduction: '39.00',
      externalPayable: '0',
      deductionValid: true,
      changed: false,
      capabilities: makeCapabilities(),
      deductionIntent: 'auto' as const,
      fundingPlan: {
        paymentMode: 'cash_alipay' as const,
        deductionIntent: 'auto' as const,
        orderPayable: '39.00',
        cashDeduction: '39.00',
        externalPayable: '0',
      },
    };

    const decision = await interaction.review(preview);
    expect(decision).toEqual({ action: 'confirm' });
  });

  it('does not duplicate a payment URL on stderr when the final JSON includes it', async () => {
    const interaction = createAutoConfirmInteraction();
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await interaction.payment('https://pay.test.qianwenai.com/qr', Promise.resolve());

    expect(stderrWrite).not.toHaveBeenCalled();
    stderrWrite.mockRestore();
  });

  it('does not write to stderr when the payment callback has no URL', async () => {
    const interaction = createAutoConfirmInteraction();
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await interaction.payment(null, Promise.resolve());

    expect(stderrWrite).not.toHaveBeenCalled();
    stderrWrite.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests: end-to-end confirm mode with service.purchase auto-confirmation
// ---------------------------------------------------------------------------

describe('--confirm command flow with mocked services', () => {
  it('settlement changes invalidate automatic confirmation while preserving the order', async () => {
    mockGetOrderSettlement.mockResolvedValueOnce({
      settledPayable: '60',
      orderId: 'PAY-001',
      currency: 'CNY',
    });
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      createAutoConfirmInteraction(),
      undefined,
      '39.00',
    );
    expect(outcome.result).toMatchObject({
      stage: 'create',
      status: 'failed',
      paymentAttempted: false,
      paymentOrderId: 'PAY-001',
    });
    expect(outcome.error?.code).toBe('TOKENPLAN_PAYMENT_RECONFIRM_REQUIRED');
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('balance changes cannot silently alter an automatically confirmed plan', async () => {
    mockGetPaymentCapabilities
      .mockResolvedValueOnce(makeCapabilities('10'))
      .mockResolvedValueOnce(makeCapabilities('10'));
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      createAutoConfirmInteraction(),
    );
    expect(outcome.error?.code).toBe('TOKENPLAN_PAYMENT_RECONFIRM_REQUIRED');
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('a quote changing before creation requires fresh authorization', async () => {
    mockGetQuote
      .mockResolvedValueOnce(makeQuote())
      .mockResolvedValueOnce(makeQuote({ amount: '40' }));
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      SELECTION,
      createAutoConfirmInteraction(),
    );
    expect(outcome.error?.code).toBe('TOKENPLAN_PAYMENT_RECONFIRM_REQUIRED');
    expect(mockCreateOrders).not.toHaveBeenCalled();
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('invalid manual cash deduction cannot be auto-confirmed', async () => {
    const outcome = await new TokenPlanPurchaseService({} as never).purchase(
      { ...SELECTION, balanceDeduction: '60' },
      createAutoConfirmInteraction(),
    );
    expect(outcome.error?.code).toBe('TOKENPLAN_BALANCE_EXCEEDED');
    expect(mockCreateOrders).not.toHaveBeenCalled();
  });

  it('rejects excessive confirm balance deductions even when a coupon covers the full price', async () => {
    mockGetQuote.mockResolvedValue(
      makeQuote({ amount: '0', tradeAmount: '0', couponDeduction: '39' }),
    );
    mockGetPaymentCapabilities.mockResolvedValue(makeCapabilities('10'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cmd = {
      opts: () => ({
        billingCycle: 'monthly',
        channel: 'alipay',
        autoRenew: false,
        confirm: true,
        coupon: 'default',
        balanceDeduction: '10.01',
        previewAmount: '0',
      }),
      parent: null,
    } as never;

    try {
      await expect(
        subscriptionTokenPlanPurchaseAction(cmd).call(cmd, SELECTION.type),
      ).rejects.toMatchObject({ name: 'HandledError', exitCode: 4 });
      expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain(
        'TOKENPLAN_BALANCE_EXCEEDED',
      );
      expect(mockCreateOrders).not.toHaveBeenCalled();
      expect(mockMergePay).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('automatically confirms the purchase in confirm mode', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = createAutoConfirmInteraction();

    const outcome = await service.purchase(SELECTION, interaction);

    expect(outcome.result.status).toBe('succeeded');
    expect(outcome.exitCode).toBe(0);
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
  });

  it('exits with code 8 for pending results without appending a generic error', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      return { status: 'pending', url: null };
    });
    mockWaitForPaymentResult.mockReturnValueOnce(new Promise(() => {}));
    const cmd = {
      opts: () => ({
        billingCycle: 'monthly',
        channel: 'alipay',
        autoRenew: false,
        confirm: true,
        coupon: 'default',
        balanceDeduction: '0',
        previewAmount: '39.00',
      }),
      parent: null,
    } as never;

    await expect(
      subscriptionTokenPlanPurchaseAction(cmd).call(cmd, SELECTION.type),
    ).rejects.toMatchObject({ name: 'HandledError', exitCode: 8 });
  });

  it('outputs only the cancelled result when confirmed by the order list', async () => {
    mockMergePay.mockImplementationOnce(async (input: TokenPlanMergePayInput) => {
      input.onRequestStart?.();
      return { status: 'pending', url: null };
    });
    mockWaitForPaymentResult.mockResolvedValueOnce({
      orderId: 'PAY-001',
      status: 'cancelled',
      reason: 'order_cancelled',
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cmd = {
      opts: () => ({
        billingCycle: 'monthly',
        channel: 'alipay',
        autoRenew: false,
        confirm: true,
        coupon: 'default',
        balanceDeduction: '0',
        previewAmount: '39.00',
      }),
      parent: null,
    } as never;

    try {
      await expect(
        subscriptionTokenPlanPurchaseAction(cmd).call(cmd, SELECTION.type),
      ).rejects.toMatchObject({ name: 'HandledError', exitCode: 1 });
      expect(buildTokenPlanPurchaseResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'cancelled', reason: 'order_cancelled' }),
      );
      expect(stderr.mock.calls.map(([value]) => value)).toEqual([
        'Preparing Token Plan quote...\n',
        'Preparing Token Plan quote...\n',
      ]);
    } finally {
      stderr.mockRestore();
    }
  });

  it('selects the coupon before confirming in confirm mode', async () => {
    const interaction = createAutoConfirmInteraction('coupon_001');
    const service = new TokenPlanPurchaseService({} as never);

    const outcome = await service.purchase(SELECTION, interaction);

    expect(outcome.result.status).toBe('succeeded');
    // getQuote should be called multiple times due to coupon switch
    expect(mockGetQuote.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseTokenPlanSelection with additional parameters
// ---------------------------------------------------------------------------

describe('parseTokenPlanSelection with PurchaseOptions fields', () => {
  it('reports consistent guidance for missing required purchase arguments', () => {
    expect(() =>
      parseTokenPlanSelection('token_plan_individual_lite', {
        channel: 'alipay',
        autoRenew: false,
      }),
    ).toThrow('--billing-cycle is required. Choose monthly, quarterly or yearly.');
    expect(() =>
      parseTokenPlanSelection('token_plan_individual_lite', {
        billingCycle: 'monthly',
        autoRenew: false,
      }),
    ).toThrow('--channel is required. Supported: alipay.');
    expect(() =>
      parseTokenPlanSelection('token_plan_individual_lite', {
        billingCycle: 'monthly',
        channel: 'alipay',
      }),
    ).toThrow('Choose exactly one of --auto-renew or --no-auto-renew.');
    expect(() =>
      parseTokenPlanSelection('token_plan_team', {
        billingCycle: 'monthly',
        channel: 'alipay',
        autoRenew: false,
      }),
    ).toThrow(
      'At least one team seat is required. Use --standard-seat-count, --pro-seat-count or --max-seat-count.',
    );
  });

  it.each(['credit', 'wechat', 'constructor', '__proto__'])(
    'rejects unsupported channel %s',
    (channel) => {
      expect(() =>
        parseTokenPlanSelection(SELECTION.type, {
          billingCycle: 'monthly',
          channel,
          autoRenew: false,
        }),
      ).toThrow('--channel only supports: alipay');
    },
  );

  it('ignores additional preview, coupon, and confirm fields during selection parsing', () => {
    const selection = parseTokenPlanSelection('token_plan_individual_lite', {
      billingCycle: 'monthly',
      channel: 'alipay',
      autoRenew: false,
      preview: true,
      coupon: 'coupon_001',
      confirm: false,
    });

    expect(selection.type).toBe('token_plan_individual_lite');
    expect(selection.edition).toBe('individual');
    expect(selection.billingCycle).toBe('monthly');
    expect(selection.autoRenew).toBe(false);
  });

  it('applies the same purchase rules to Essential and other individual tiers', () => {
    const selection = parseTokenPlanSelection('token_plan_individual_essential', {
      billingCycle: 'quarterly',
      channel: 'alipay',
      autoRenew: false,
      coupon: false,
      previewAmount: '39.00',
    });

    expect(selection.type).toBe('token_plan_individual_essential');
    expect(selection.edition).toBe('individual');
    expect(selection.billingCycle).toBe('quarterly');
    expect(selection.seats).toEqual([{ specCode: 'essential', quantity: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Tests: command-level --preview and --confirm compatibility
// ---------------------------------------------------------------------------

describe('option combinations and conflicts', () => {
  it('parses the selection consistently with preview and confirm options', () => {
    // This validates that the options don't interfere with selection parsing
    const selection = parseTokenPlanSelection('token_plan_individual_standard', {
      billingCycle: 'quarterly',
      channel: 'alipay',
      autoRenew: false,
    });
    expect(selection.edition).toBe('individual');
    expect(selection.billingCycle).toBe('quarterly');
  });

  function makeMockCommand(opts: Record<string, unknown>) {
    return {
      opts: () => opts,
      parent: null,
    } as never;
  }

  it('rejects a missing renewal mode before authentication or quoting', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command().exitOverride();
    registerSubscriptionTokenPlanCommands(program);

    await expect(
      program.parseAsync(
        [
          'tokenplan',
          'purchase',
          SELECTION.type,
          '--billing-cycle',
          'monthly',
          '--channel',
          'alipay',
          '--preview',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow();

    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain(
      'Choose exactly one of --auto-renew or --no-auto-renew.',
    );
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(mockGetCommodity).not.toHaveBeenCalled();
    expect(mockCreateOrders).not.toHaveBeenCalled();
  });

  it.each([
    ['--auto-renew', '--no-auto-renew'],
    ['--no-auto-renew', '--auto-renew'],
  ])('rejects conflicting renewal modes: %j', async (...flags) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command().exitOverride();
    registerSubscriptionTokenPlanCommands(program);

    await expect(
      program.parseAsync(
        [
          'tokenplan',
          'purchase',
          SELECTION.type,
          '--billing-cycle',
          'monthly',
          '--channel',
          'alipay',
          '--preview',
          ...flags,
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow();

    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain(
      '--auto-renew and --no-auto-renew cannot be combined.',
    );
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(mockGetCommodity).not.toHaveBeenCalled();
    expect(mockCreateOrders).not.toHaveBeenCalled();
  });

  it('rejects --preview-amount without --confirm with TOKENPLAN_INVALID_OPTIONS', async () => {
    const cmd = makeMockCommand({
      billingCycle: 'monthly',
      channel: 'alipay',
      autoRenew: false,
      previewAmount: '39.00',
    });
    const action = subscriptionTokenPlanPurchaseAction(cmd);
    await expect(action.call(cmd, 'token_plan_individual_standard')).rejects.toThrow(
      expect.objectContaining({
        code: 'TOKENPLAN_INVALID_OPTIONS',
        message: '--preview-amount requires --confirm.',
        exitCode: 1,
      }),
    );
  });

  it('rejects --preview-amount with --preview but without --confirm with TOKENPLAN_INVALID_OPTIONS', async () => {
    const cmd = makeMockCommand({
      billingCycle: 'monthly',
      channel: 'alipay',
      autoRenew: false,
      preview: true,
      previewAmount: '39.00',
    });
    const action = subscriptionTokenPlanPurchaseAction(cmd);
    // --preview and --confirm are mutually exclusive, but --preview-amount requires --confirm
    // The --preview+--confirm mutual-exclusion check fires first, then --preview-amount+--confirm.
    // Since --confirm is absent, --preview-amount check triggers.
    await expect(action.call(cmd, 'token_plan_individual_standard')).rejects.toThrow(
      expect.objectContaining({
        code: 'TOKENPLAN_INVALID_OPTIONS',
        message: '--preview-amount requires --confirm.',
        exitCode: 1,
      }),
    );
  });

  it('requires explicit coupon, balance deduction, and preview amount options before confirming a purchase', async () => {
    const cases = [
      {
        options: { balanceDeduction: '0', previewAmount: '39.00' },
        message: '--confirm requires exactly one of --coupon <coupon-id> or --no-coupon.',
      },
      {
        options: { coupon: 'default', previewAmount: '39.00' },
        message:
          '--confirm requires --balance-deduction <amount>; pass 0 to disable balance deduction.',
      },
      {
        options: { coupon: 'default', balanceDeduction: '0' },
        message:
          '--confirm requires --preview-amount <amount> from the preceding --preview result.',
      },
    ];

    for (const testCase of cases) {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.mocked(ensureAuthenticated).mockClear();
      mockGetCommodity.mockClear();
      const cmd = makeMockCommand({
        billingCycle: 'monthly',
        channel: 'alipay',
        autoRenew: false,
        confirm: true,
        ...testCase.options,
      });
      await expect(
        subscriptionTokenPlanPurchaseAction(cmd).call(cmd, SELECTION.type),
      ).rejects.toMatchObject({ name: 'HandledError', exitCode: 1 });
      expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain(
        testCase.message,
      );
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(mockGetCommodity).not.toHaveBeenCalled();
      stderr.mockRestore();
    }

    const cmd = makeMockCommand({
      billingCycle: 'monthly',
      channel: 'alipay',
      autoRenew: false,
      confirm: true,
      coupon: 'default',
      balanceDeduction: '0',
      previewAmount: '39.00',
    });
    await expect(
      subscriptionTokenPlanPurchaseAction(cmd).call(cmd, SELECTION.type),
    ).resolves.toBeUndefined();
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: --no-coupon flag
// ---------------------------------------------------------------------------

describe('--no-coupon option', () => {
  it.each([
    ['--coupon', 'coupon_001', '--no-coupon'],
    ['--no-coupon', '--coupon', 'coupon_001'],
    ['--coupon=coupon_001', '--no-coupon'],
    ['--no-coupon', '--coupon=coupon_001'],
  ])('case %#: real command registration rejects conflicting coupon argv: %j', async (...flags) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command().exitOverride();
    registerSubscriptionTokenPlanCommands(program);
    await expect(
      program.parseAsync(
        [
          'tokenplan',
          'purchase',
          SELECTION.type,
          '--billing-cycle',
          'monthly',
          '--channel',
          'alipay',
          '--no-auto-renew',
          '--preview',
          ...flags,
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow();
    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain(
      '--coupon and --no-coupon are mutually exclusive',
    );
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(mockGetCommodity).not.toHaveBeenCalled();
    expect(mockCreateOrders).not.toHaveBeenCalled();
  });

  it('real --no-coupon parsing passes the sentinel into preview without writes', async () => {
    const program = new Command().exitOverride();
    registerSubscriptionTokenPlanCommands(program);
    await program.parseAsync(
      [
        'tokenplan',
        'purchase',
        SELECTION.type,
        '--billing-cycle',
        'monthly',
        '--channel',
        'alipay',
        '--no-auto-renew',
        '--preview',
        '--no-coupon',
      ],
      { from: 'user' },
    );
    expect(mockGetQuote.mock.calls[0][1]).toBe(NO_TOKENPLAN_COUPON);
    expect(mockCreateOrders).not.toHaveBeenCalled();
    expect(mockMergePay).not.toHaveBeenCalled();
  });

  it('createAutoConfirmInteraction selects no coupon before confirming NO_TOKENPLAN_COUPON', async () => {
    const interaction = createAutoConfirmInteraction(NO_TOKENPLAN_COUPON);

    const previewData = {
      selection: SELECTION,
      quote: makeQuote({ coupon: 'default' }),
      balance: '50.00',
      maxDeduction: '39.00',
      balanceDeduction: '39.00',
      externalPayable: '0',
      deductionValid: true,
      changed: false,
      capabilities: makeCapabilities(),
      deductionIntent: 'auto' as const,
      fundingPlan: {
        paymentMode: 'cash_alipay' as const,
        deductionIntent: 'auto' as const,
        orderPayable: '39.00',
        cashDeduction: '39.00',
        externalPayable: '0',
      },
    };

    // First call: switch to no-coupon sentinel
    const decision1 = await interaction.review(previewData);
    expect(decision1).toEqual({ action: 'coupon', coupon: NO_TOKENPLAN_COUPON });

    // Second call: sentinel matches → confirm
    const previewNoCoupon = {
      ...previewData,
      quote: makeQuote({ coupon: NO_TOKENPLAN_COUPON }),
    };
    const decision2 = await interaction.review(previewNoCoupon);
    expect(decision2).toEqual({ action: 'confirm' });
  });

  it('uses NO_TOKENPLAN_COUPON for the first quote when --no-coupon is set', async () => {
    mockGetQuote.mockImplementation(async (_configurations, coupon) =>
      makeQuote({ coupon: String(coupon) }),
    );
    const program = new Command().exitOverride();
    registerSubscriptionTokenPlanCommands(program);

    await program.parseAsync(
      [
        'tokenplan',
        'purchase',
        SELECTION.type,
        '--billing-cycle',
        'monthly',
        '--channel',
        'alipay',
        '--no-auto-renew',
        '--confirm',
        '--no-coupon',
        '--balance-deduction',
        '0',
        '--preview-amount',
        '39.00',
      ],
      { from: 'user' },
    );

    expect(mockGetQuote.mock.calls[0][1]).toBe(NO_TOKENPLAN_COUPON);
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
  });
});

describe('Token Plan agent options', () => {
  it('remain hidden in Commander metadata but are documented for Agent and Skill use', async () => {
    const program = new Command();
    registerSubscriptionTokenPlanCommands(program);
    const tokenplan = program.commands.find((command) => command.name() === 'tokenplan');
    const purchase = tokenplan?.commands.find((command) => command.name() === 'purchase');

    expect(purchase).toBeDefined();
    const hiddenFlags = [
      '--balance-deduction',
      '--preview',
      '--confirm',
      '--coupon',
      '--no-coupon',
      '--preview-amount',
    ];
    const help = purchase?.helpInformation() ?? '';
    for (const flag of hiddenFlags) {
      expect(help).toContain(flag);
      expect(purchase?.options.find((option) => option.long === flag)?.hidden).toBe(true);
    }
    expect(help).toContain('Agent and Skill options:');
    expect(help).toContain('--format <fmt>');
    expect(help).toContain('--confirm requires --coupon or --no-coupon, --balance-deduction,');
    expect(help).toContain('and --preview-amount.');
    purchase?.parseOptions(['--balance-deduction', '12.34']);
    expect(purchase?.opts().balanceDeduction).toBe('12.34');
  });
});

// ---------------------------------------------------------------------------
// Tests: --preview-amount anchor validation
// ---------------------------------------------------------------------------

describe('--preview-amount validation', () => {
  it('creates an order when previewAmount matches the quote', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = createAutoConfirmInteraction();

    const outcome = await service.purchase(SELECTION, interaction, undefined, '39.00');

    expect(outcome.result.status).toBe('succeeded');
    expect(outcome.exitCode).toBe(0);
    expect(mockCreateOrders).toHaveBeenCalledTimes(1);
  });

  it('rejects order creation when previewAmount differs from the quote', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = createAutoConfirmInteraction();

    const outcome = await service.purchase(SELECTION, interaction, undefined, '42.00');

    expect(outcome.result.status).toBe('failed');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.error?.code).toBe('TOKENPLAN_QUOTE_CHANGED');
    // No order should have been created
    expect(mockCreateOrders).not.toHaveBeenCalled();
  });

  it('preserves the existing flow when previewAmount is omitted', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = createAutoConfirmInteraction();

    const outcome = await service.purchase(SELECTION, interaction, undefined, undefined);

    expect(outcome.result.status).toBe('succeeded');
    expect(outcome.exitCode).toBe(0);
  });

  it('accepts numerically equal preview amounts with different formatting', async () => {
    const service = new TokenPlanPurchaseService({} as never);
    const interaction = createAutoConfirmInteraction();

    // Quote returns '39.00', previewAmount is '39'
    // DecimalAmount.parse('39') and DecimalAmount.parse('39.00') should be equal
    mockGetQuote.mockImplementation(async () => makeQuote({ amount: '39', tradeAmount: '39' }));
    const outcome = await service.purchase(SELECTION, interaction, undefined, '39');

    expect(outcome.result.status).toBe('succeeded');
    expect(outcome.exitCode).toBe(0);
  });
});
