/** Unit tests for Token Plan purchase view-models. */
import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import {
  buildTokenPlanPaymentDisplay,
  buildTokenPlanPurchasePreview,
  buildTokenPlanPurchaseResult,
} from '../../../src/view-models/subscription/tokenplan-purchase.js';
import { createTokenPlanPurchaseInteraction } from '../../../src/ui/TokenPlanPurchase.js';
import type {
  TokenPlanPurchasePreview,
  TokenPlanPurchaseResult,
  TokenPlanQuote,
} from '../../../src/types/tokenplan-purchase.js';
import type {
  CashFundingPlan,
  CashPaymentCapabilities,
} from '../../../src/types/tokenplan-payment.js';

const { renderInteractiveMock, questionMock, closeReaderMock } = vi.hoisted(() => ({
  renderInteractiveMock: vi.fn(),
  questionMock: vi.fn(),
  closeReaderMock: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: questionMock, close: closeReaderMock })),
}));

vi.mock('../../../src/ui/render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ui/render.js')>();
  return { ...actual, renderInteractive: renderInteractiveMock };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQuote(overrides?: Partial<TokenPlanQuote>): TokenPlanQuote {
  return {
    amount: '80.00',
    tradeAmount: '99.00',
    currency: 'CNY',
    coupon: 'youhuiquan_promotion_option_id_for_blank',
    coupons: [],
    originalAmount: '99.00',
    planAmount: '80.00',
    promotionDeduction: '19.00',
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

function makeFundingPlan(overrides?: Partial<CashFundingPlan>): CashFundingPlan {
  return {
    paymentMode: 'cash_alipay',
    deductionIntent: 'auto',
    orderPayable: '80.00',
    cashDeduction: '50.00',
    externalPayable: '30.00',
    ...overrides,
  };
}

function makePreview(overrides?: Partial<TokenPlanPurchasePreview>): TokenPlanPurchasePreview {
  const fundingPlan = overrides?.fundingPlan ?? makeFundingPlan();
  return {
    selection: {
      type: 'token_plan_individual_standard',
      edition: 'individual',
      billingCycle: 'monthly',
      seats: [{ specCode: 'standard', quantity: 1 }],
      autoRenew: false,
      balanceDeduction: null,
    },
    quote: makeQuote(),
    balance: '200.00',
    maxDeduction: '80.00',
    balanceDeduction: fundingPlan.cashDeduction,
    externalPayable: fundingPlan.externalPayable,
    deductionValid: true,
    changed: false,
    capabilities: makeCapabilities(),
    fundingPlan,
    deductionIntent: fundingPlan.deductionIntent,
    ...overrides,
  };
}

function makeResult(overrides?: Partial<TokenPlanPurchaseResult>): TokenPlanPurchaseResult {
  return {
    stage: 'payment',
    status: 'succeeded',
    type: 'token_plan_individual_standard',
    billingCycle: 'monthly',
    amount: '80.00',
    currency: 'CNY',
    requestedAutoRenew: false,
    autoRenewStatus: 'disabled',
    paymentOrderId: 'PAY-001',
    orderIds: ['ORD-001'],
    activationStatus: 'visible',
    paymentMode: 'cash_alipay',
    cashDeduction: '50.00',
    externalPayable: '30.00',
    paymentAttempted: true,
    period: { start: '2026-09-10', end: '2026-10-10' },
    ...overrides,
  };
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// buildTokenPlanPurchasePreview
// ---------------------------------------------------------------------------

describe('buildTokenPlanPurchasePreview field labels', () => {
  it.each([false, true])(
    'explains quote refresh before purchase details (changed=%s)',
    (changed) => {
      const vm = buildTokenPlanPurchasePreview(makePreview({ changed }));

      expect(vm.lines.slice(0, 2)).toEqual([
        'Each quote is based on your current selections.',
        'It is refreshed before purchase, so amounts may change.',
      ]);
      expect(vm.lines.findIndex((line) => line.startsWith('TYPE'))).toBeGreaterThan(1);
      expect(vm.lines.includes('Quote or selection changed. Review and confirm again.')).toBe(
        changed,
      );
    },
  );

  it('existing-order review shows original funding and removes coupon changes', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        existingOrder: {
          paymentOrderId: 'order-1',
          orderIds: ['order-1', 'order-2'],
          confirmedFundingPlan: makeFundingPlan(),
        },
        changed: true,
      }),
    );
    expect(vm.title).toBe('CONFIRM EXISTING ORDER PAYMENT');
    expect(vm.lines.join('\n')).toContain('order-1, order-2');
    expect(vm.lines.join('\n')).toContain('PREVIOUS CASH');
    expect(vm.lines).toContain(
      'The order already exists. This confirmation does not create another order or change coupons.',
    );
    expect(vm.lines.join('\n')).not.toContain('refreshed before purchase');
    expect(vm.options.some((option) => option.decision.action === 'select-coupon')).toBe(false);
  });

  it('invalid manual amounts expose adjustment choices but no confirmable funding plan', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        deductionValid: false,
        fundingPlan: null,
        balanceDeduction: '100',
        externalPayable: null,
        deductionIntent: 'manual',
      }),
    );
    expect(vm.options.some((option) => option.decision.action === 'confirm')).toBe(false);
    expect(vm.options).toContainEqual(
      expect.objectContaining({
        key: '3',
        label: 'Change balance deduction',
        decision: { action: 'custom-deduction' },
      }),
    );
    expect(vm.lines.join('\n')).toContain('unknown');
  });
  it('renders the PRD quote fields without internal order or deduction-mode fields', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        selection: {
          type: 'token_plan_individual_essential',
          edition: 'individual',
          billingCycle: 'monthly',
          seats: [{ specCode: 'essential', quantity: 1 }],
          autoRenew: false,
          balanceDeduction: null,
        },
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).toContain('PLAN AMOUNT');
    expect(body).toContain('PAYABLE AMOUNT');
    expect(body).toContain('PLAN                  Essential');
    expect(body).not.toContain('ORDER AMOUNT');
    expect(body).not.toContain('DEDUCTION MODE');
  });

  it('uses quote.planAmount for PLAN AMOUNT', () => {
    const vm = buildTokenPlanPurchasePreview(makePreview());
    const planLine = vm.lines.find((line) => line.startsWith('PLAN AMOUNT'));
    expect(planLine).toContain('¥80.00 CNY');
  });

  it('shows list and sale prices separately without changing the payable amount', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        quote: makeQuote({
          amount: '396',
          tradeAmount: '396',
          originalAmount: '540',
          planAmount: '417',
          promotionDeduction: '123',
        }),
      }),
    );
    expect(vm.lines.find((line) => line.startsWith('ORIGINAL AMOUNT'))).toContain('¥540.00 CNY');
    expect(vm.lines.find((line) => line.startsWith('PLAN AMOUNT'))).toContain('¥417.00 CNY');
    expect(vm.lines.find((line) => line.startsWith('PAYABLE AMOUNT'))).toContain('¥30.00 CNY');
  });

  it('COUPON DEDUCTION shows negative amount when coupon is selected with deductionAmount', () => {
    const couponId = 'test-coupon-deduct';
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        quote: makeQuote({
          coupon: couponId,
          coupons: [{ id: couponId, name: 'Test', deductionAmount: '19.00' }],
          originalAmount: '99.00',
          planAmount: '99.00',
          promotionDeduction: '0',
          couponDeduction: '19.00',
        }),
      }),
    );
    const couponLine = vm.lines.find((line) => line.trimStart().startsWith('COUPON DEDUCTION'));
    expect(couponLine).toContain('-¥19.00 CNY');
  });

  it('hides COUPON DEDUCTION when no coupon is applied', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({ quote: makeQuote({ couponDeduction: '0' }) }),
    );
    const couponLine = vm.lines.find((line) => line.trimStart().startsWith('COUPON DEDUCTION'));
    expect(couponLine).toBeUndefined();
  });

  it('PAYABLE AMOUNT shows Cash balance only when fully paid by cash', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        fundingPlan: makeFundingPlan({ cashDeduction: '80.00', externalPayable: '0' }),
        externalPayable: '0',
      }),
    );
    const alipayLine = vm.lines.find((line) => line.startsWith('PAYABLE AMOUNT'));
    expect(alipayLine).toContain('No Alipay QR needed');
  });

  it('hides coupon option when no coupons are available', () => {
    const vm = buildTokenPlanPurchasePreview(makePreview());
    expect(vm.options.some((option) => option.decision.action === 'select-coupon')).toBe(false);
    const keys = vm.options.map((o) => o.key);
    expect(keys).not.toContain('2');
  });

  it('uses the compact confirm, coupon, balance, and cancel menu', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        quote: makeQuote({
          coupons: [{ id: 'c1', name: 'Coupon', deductionAmount: '10.00' }],
        }),
      }),
    );
    const confirm = vm.options.find((option) => option.key === '1');
    expect(confirm).toBeDefined();
    expect(vm.options.every((option) => !option.key.includes('['))).toBe(true);
    const keys = vm.options.map((o) => o.key);
    expect(keys).toEqual(['1', '2', '3', '0']);
    expect(vm.options.find((option) => option.key === '3')?.label).toBe('Change balance deduction');
  });

  it('formats the default editable balance deduction as a negative amount', () => {
    const vm = buildTokenPlanPurchasePreview(makePreview());
    const line = vm.lines.find((candidate) => candidate.startsWith('BALANCE DEDUCTION'));

    expect(line).toBe(`${'BALANCE DEDUCTION'.padEnd(22)}-¥50.00 CNY (default; editable)`);
  });

  it('hides the balance deduction option when balance is 0', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        quote: makeQuote({
          coupons: [{ id: 'c1', name: 'Coupon', deductionAmount: '10.00' }],
        }),
        balance: '0.00',
        maxDeduction: '0',
        fundingPlan: makeFundingPlan({ cashDeduction: '0', externalPayable: '80.00' }),
        balanceDeduction: '0',
        externalPayable: '80.00',
      }),
    );
    const keys = vm.options.map((o) => o.key);
    expect(keys).toEqual(['1', '2', '0']);
    expect(keys).not.toContain('3');
  });

  it('also hides the balance deduction option when maxDeduction is "0.00"', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        quote: makeQuote({
          coupons: [{ id: 'c1', name: 'Coupon', deductionAmount: '10.00' }],
        }),
        balance: '0.00',
        maxDeduction: '0.00',
        fundingPlan: makeFundingPlan({ cashDeduction: '0', externalPayable: '80.00' }),
        balanceDeduction: '0',
        externalPayable: '80.00',
      }),
    );
    const keys = vm.options.map((o) => o.key);
    expect(keys).toEqual(['1', '2', '0']);
  });

  it('hides the balance deduction option when coupon covers the full amount', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        quote: makeQuote({
          amount: '0',
          coupons: [{ id: 'c1', name: 'Coupon', deductionAmount: '80.00' }],
        }),
        balance: '200.00',
        maxDeduction: '0',
        fundingPlan: makeFundingPlan({ cashDeduction: '0', externalPayable: '0' }),
        balanceDeduction: '0',
        externalPayable: '0',
      }),
    );
    const keys = vm.options.map((o) => o.key);
    expect(keys).not.toContain('3');
    expect(keys).toEqual(['1', '2', '0']);
    expect(vm.lines.find((line) => line.startsWith('BALANCE DEDUCTION'))).toBe(
      `${'BALANCE DEDUCTION'.padEnd(22)}¥0.00 CNY`,
    );
  });

  it('coupon detail shows balance, face value, validity, and deduction', () => {
    const couponId = 'test-coupon-001';
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        quote: makeQuote({
          coupon: couponId,
          originalAmount: '99.00',
          planAmount: '99.00',
          promotionDeduction: '0',
          couponDeduction: '19.00',
          coupons: [
            {
              id: couponId,
              name: 'Test Coupon',
              balance: '100.00',
              faceValue: '200.00',
              validUntil: '2026-12-31',
              deductionAmount: '19.00',
              recommended: true,
            },
          ],
        }),
      }),
    );
    const expectedField = (label: string, value: string) => `${label.padEnd(22)}${value}`;
    expect(vm.lines).toEqual([
      'Each quote is based on your current selections.',
      'It is refreshed before purchase, so amounts may change.',
      expectedField('TYPE', 'token_plan_individual_standard'),
      expectedField('PRODUCT', 'Token Plan Individual'),
      expectedField('PLAN', 'Standard'),
      expectedField('BILLING CYCLE', 'Monthly'),
      expectedField('PLAN AMOUNT', '¥99.00 CNY'),
      '',
      expectedField('SELECTED COUPON', 'Test Coupon (Recommended)'),
      expectedField('COUPON BALANCE', '¥100.00 CNY'),
      expectedField('COUPON FACE VALUE', '¥200.00 CNY'),
      expectedField('COUPON VALID UNTIL', '2026-12-31'),
      expectedField('COUPON DEDUCTION', '-¥19.00 CNY'),
      '',
      expectedField('ACCOUNT BALANCE', '¥200.00 CNY'),
      expectedField('BALANCE DEDUCTION', '-¥50.00 CNY (default; editable)'),
      '',
      expectedField('PAYABLE AMOUNT', '¥30.00 CNY'),
      expectedField('AUTO-RENEW', 'Disabled'),
    ]);
    // Only coupon-detail COUPON DEDUCTION line (no duplicate quote-level line)
    const deductionLines = vm.lines.filter((line) =>
      line.trimStart().startsWith('COUPON DEDUCTION'),
    );
    expect(deductionLines.length).toBe(1);
  });

  it('team edition seat table only shows fact-backed seat quantities', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        selection: {
          type: 'token_plan_team',
          edition: 'team',
          billingCycle: 'monthly',
          seats: [
            { specCode: 'standard', quantity: 2 },
            { specCode: 'pro', quantity: 1 },
            { specCode: 'max', quantity: 3 },
          ],
          autoRenew: false,
          balanceDeduction: null,
        },
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).toContain('SEAT TYPE');
    expect(body).toContain('QUANTITY');
    expect(body).not.toContain('UNIT PRICE');
    expect(body).not.toContain('SUBTOTAL');
    expect(body).toContain('Standard Seat');
    expect(body).toContain('Pro Seat');
    expect(body).toContain('Max Seat');
    expect(body).toContain('TOTAL SEATS');
  });

  it('team edition does not infer a single-seat unit price from the aggregate quote', () => {
    const vm = buildTokenPlanPurchasePreview(
      makePreview({
        selection: {
          type: 'token_plan_team',
          edition: 'team',
          billingCycle: 'monthly',
          seats: [{ specCode: 'standard', quantity: 2 }],
          autoRenew: false,
          balanceDeduction: null,
        },
        quote: makeQuote({ originalAmount: '198.00', planAmount: '150.00' }),
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).not.toContain('UNIT PRICE');
    expect(body).not.toContain('SUBTOTAL');
    expect(body).toContain('Standard Seat         2');
    expect(body).toContain('ORIGINAL AMOUNT       ¥198.00 CNY');
    expect(body).toContain('PLAN AMOUNT           ¥150.00 CNY');
  });
});

describe('buildTokenPlanPaymentDisplay PRD output', () => {
  const expectedField = (label: string, value: string) => `${label.padEnd(22)}${value}`;

  it('shows the order payment summary during individual QR payment', () => {
    expect(
      buildTokenPlanPaymentDisplay({
        paymentOrderId: '299466212730032',
        type: 'token_plan_individual_standard',
        billingCycle: 'monthly',
        payableAmount: '179.43',
      }),
    ).toEqual([
      expectedField('ORDER ID', '299466212730032'),
      expectedField('PAYABLE AMOUNT', '¥179.43 CNY'),
      expectedField('CHANNEL', 'Alipay'),
    ]);
  });

  it('shows the type, billing cycle, and total seats during team QR payment', () => {
    expect(
      buildTokenPlanPaymentDisplay({
        paymentOrderId: '299466212730032',
        type: 'token_plan_team',
        billingCycle: 'yearly',
        payableAmount: '25676',
        totalSeats: 4,
      }),
    ).toEqual([
      expectedField('ORDER ID', '299466212730032'),
      expectedField('TYPE', 'token_plan_team'),
      expectedField('BILLING CYCLE', 'Yearly'),
      expectedField('TOTAL SEATS', '4'),
      expectedField('PAYABLE AMOUNT', '¥25676.00 CNY'),
      expectedField('CHANNEL', 'Alipay'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildTokenPlanPurchaseResult
// ---------------------------------------------------------------------------

describe('buildTokenPlanPurchaseResult output title', () => {
  it('title is Token Plan activated when activation is visible', () => {
    const vm = buildTokenPlanPurchaseResult(
      makeResult({ status: 'succeeded', activationStatus: 'visible' }),
    );
    expect(vm.lines[0]).toContain('Token Plan activated');
    expect(vm.lines).toContain('To check the activation status, run:');
    expect(vm.data.activationStatus).toBe('visible');
  });

  it.each(['pending', 'not_checked'] as const)(
    'confirms purchase success without claiming activation when activation is %s',
    (activationStatus) => {
      const vm = buildTokenPlanPurchaseResult(makeResult({ activationStatus }));
      expect(vm.lines[0]).toBe('✓ Token Plan purchase successful.');
      expect(vm.lines).toContain('Token Plan activation is not yet confirmed.');
      expect(vm.lines).toContain('To check the activation status, run:');
      expect(vm.lines).toContain('  qianwen subscription tokenplan status');
      expect(joinLines(vm.lines)).not.toContain('Token Plan activated');
      expect(joinLines(vm.lines)).not.toContain('Activation is in progress');
      expect(vm.data.status).toBe('succeeded');
      expect(vm.data.activationStatus).toBe(activationStatus);
    },
  );

  it.each(['failed', 'pending', 'cancelled', 'timed_out', 'unknown'] as const)(
    'does not claim purchase success when payment status is %s',
    (status) => {
      const vm = buildTokenPlanPurchaseResult(
        makeResult({ status, activationStatus: 'not_checked' }),
      );
      expect(joinLines(vm.lines)).not.toContain('Token Plan purchase successful');
      expect(joinLines(vm.lines)).not.toContain('Token Plan activated');
      expect(vm.data.status).toBe(status);
    },
  );

  it('preflight failure shows No payment was created', () => {
    const vm = buildTokenPlanPurchaseResult(
      makeResult({
        stage: 'preflight',
        status: 'failed',
        paymentOrderId: null,
        orderIds: null,
        paymentAttempted: false,
        activationStatus: 'not_checked',
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).toContain('No Token Plan was activated. No payment was created.');
  });

  it('post-order failure shows order created but payment not proceeded', () => {
    const vm = buildTokenPlanPurchaseResult(
      makeResult({
        stage: 'create',
        status: 'unknown',
        paymentOrderId: 'PAY-001',
        orderIds: ['ORD-001'],
        activationStatus: 'not_checked',
        paymentAttempted: true,
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).toContain('Order was created but payment could not proceed.');
    expect(body).toContain('An order was created; the purchase is not complete.');
  });

  it('create stage without paymentOrderId shows outcome is unknown', () => {
    const vm = buildTokenPlanPurchaseResult(
      makeResult({
        stage: 'create',
        status: 'unknown',
        paymentOrderId: null,
        orderIds: null,
        activationStatus: 'not_checked',
        paymentAttempted: true,
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).toContain('Order creation outcome is unknown.');
  });
});

// ---------------------------------------------------------------------------
// buildTokenPlanPurchaseResult scenario branches
// ---------------------------------------------------------------------------

describe('buildTokenPlanPurchaseResult cancelled (pre-order) field trimming', () => {
  const cancelledBeforeCreate = makeResult({
    stage: 'preflight',
    status: 'cancelled',
    paymentOrderId: null,
    orderIds: null,
    paymentAttempted: false,
    activationStatus: 'not_checked',
    autoRenewStatus: 'unknown',
    requestedAutoRenew: false,
  });

  it('shows hint text No order was created', () => {
    const vm = buildTokenPlanPurchaseResult(cancelledBeforeCreate);
    const body = joinLines(vm.lines);
    expect(body).toContain('No order was created. No payment was made.');
  });

  it('renders TYPE / PRODUCT / PLAN / BILLING CYCLE / AUTO-RENEW', () => {
    const vm = buildTokenPlanPurchaseResult(cancelledBeforeCreate);
    const body = joinLines(vm.lines);
    expect(body).toContain('TYPE');
    expect(body).toContain('BILLING CYCLE');
    expect(body).toContain('AUTO-RENEW');
  });

  it('AUTO-RENEW shows Disabled directly (without Unknown prefix or requested)', () => {
    const vm = buildTokenPlanPurchaseResult(cancelledBeforeCreate);
    const autoRenewLine = vm.lines.find((l) => l.startsWith('AUTO-RENEW'));
    expect(autoRenewLine).toContain('Disabled');
    expect(autoRenewLine).not.toContain('Unknown');
    expect(autoRenewLine).not.toContain('requested');
  });

  it('AUTO-RENEW shows Enabled when requestedAutoRenew is true', () => {
    const vm = buildTokenPlanPurchaseResult({ ...cancelledBeforeCreate, requestedAutoRenew: true });
    const autoRenewLine = vm.lines.find((l) => l.startsWith('AUTO-RENEW'));
    expect(autoRenewLine).toContain('Enabled');
  });

  it('omits STATUS / STAGE / ORDER ID / BALANCE / ALIPAY / ACTIVATION / PERIOD', () => {
    const vm = buildTokenPlanPurchaseResult(cancelledBeforeCreate);
    const body = joinLines(vm.lines);
    expect(body).not.toContain('STATUS');
    expect(body).not.toContain('STAGE');
    expect(body).not.toContain('ORDER ID');
    expect(body).not.toContain('BALANCE DEDUCTION');
    expect(body).not.toContain('AMOUNT PAID');
    expect(body).not.toContain('ACTIVATION');
    expect(body).not.toContain('PERIOD');
    expect(body).not.toContain('QUOTED AMOUNT');
    expect(body).not.toContain('CHANNEL');
  });

  it('JSON data object remains complete', () => {
    const vm = buildTokenPlanPurchaseResult(cancelledBeforeCreate);
    expect(vm.data.stage).toBe('preflight');
    expect(vm.data.status).toBe('cancelled');
    expect(vm.data.paymentOrderId).toBeNull();
    expect(vm.data.activationStatus).toBe('not_checked');
  });
});

describe('buildTokenPlanPurchaseResult canceled order recovery', () => {
  it('distinguishes a remotely canceled order from stopping the local CLI', () => {
    const vm = buildTokenPlanPurchaseResult(
      makeResult({
        stage: 'payment',
        status: 'cancelled',
        reason: 'order_cancelled',
        paymentOrderId: '1234567890',
        orderIds: ['1234567890'],
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).toContain('Order canceled.');
    expect(body).toContain('The order was canceled. No payment was completed.');
    expect(body).not.toContain('Stopping the CLI does not cancel');
    expect(vm.data).toMatchObject({ status: 'cancelled', reason: 'order_cancelled' });
  });
});

describe('buildTokenPlanPurchaseResult preflight failure field trimming', () => {
  const preflightFailed = makeResult({
    stage: 'preflight',
    status: 'failed',
    paymentOrderId: null,
    orderIds: null,
    paymentAttempted: false,
    activationStatus: 'not_checked',
  });

  it('renders TYPE / PRODUCT / PLAN / BILLING CYCLE', () => {
    const vm = buildTokenPlanPurchaseResult(preflightFailed);
    const body = joinLines(vm.lines);
    expect(body).toContain('TYPE');
    expect(body).toContain('BILLING CYCLE');
  });

  it('omits STATUS / STAGE / ORDER ID / BALANCE / AMOUNT PAID / ACTIVATION / PERIOD / AUTO-RENEW', () => {
    const vm = buildTokenPlanPurchaseResult(preflightFailed);
    const body = joinLines(vm.lines);
    expect(body).not.toContain('STATUS');
    expect(body).not.toContain('STAGE');
    expect(body).not.toContain('ORDER ID');
    expect(body).not.toContain('BALANCE DEDUCTION');
    expect(body).not.toContain('AMOUNT PAID');
    expect(body).not.toContain('ACTIVATION');
    expect(body).not.toContain('PERIOD');
    expect(body).not.toContain('QUOTED AMOUNT');
    expect(body).not.toContain('CHANNEL');
    expect(body).not.toContain('AUTO-RENEW');
  });

  it('JSON data object remains complete', () => {
    const vm = buildTokenPlanPurchaseResult(preflightFailed);
    expect(vm.data.stage).toBe('preflight');
    expect(vm.data.status).toBe('failed');
    expect(vm.data.paymentAttempted).toBe(false);
  });
});

describe('buildTokenPlanPurchaseResult full display after order creation', () => {
  it('shows all payment and activation fields on success', () => {
    const vm = buildTokenPlanPurchaseResult(makeResult());
    const body = joinLines(vm.lines);
    expect(body).toContain('STATUS');
    expect(body).toContain('STAGE');
    expect(body).toContain('ORDER ID');
    expect(body).toContain('BALANCE DEDUCTION');
    expect(body).toContain('ALIPAY PAYABLE');
    expect(body).toContain('AUTO-RENEW');
    expect(body).toContain('ACTIVATION');
    expect(body).toContain('PERIOD');
    expect(body).toContain('QUOTED AMOUNT');
    expect(body).toContain('CHANNEL');
  });

  it('shows recovery commands on post-order failure', () => {
    const vm = buildTokenPlanPurchaseResult(
      makeResult({
        stage: 'payment',
        status: 'failed',
        paymentOrderId: 'PAY-999',
        activationStatus: 'not_checked',
        paymentAttempted: true,
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).toContain('Check order status:');
    expect(body).toContain('qianwen subscription orders --type purchase');
    expect(body).toContain('https://platform.qianwenai.com/home/billing/subscription');
    expect(body).not.toContain('https://platform.qianwenai.com/home/billing/orders');
    expect(body).toContain('PAY-999');
    expect(body).toContain('ORDER ID');
    expect(body).toContain('BALANCE DEDUCTION');
  });

  it('shows settlement drift notice when settlementDrifted=true', () => {
    const vm = buildTokenPlanPurchaseResult(
      makeResult({
        settlementDrifted: true,
        settledAmount: '95.00',
      }),
    );
    const body = joinLines(vm.lines);
    expect(body).toContain('Payment uses the reconfirmed funding plan for this order.');
    expect(body).toContain('SETTLED AMOUNT');
    expect(vm.data.settlementDrifted).toBe(true);
    expect(vm.data.settledAmount).toBe('95.00');
  });

  it('includes the payment URL and safe follow-up warning in all result surfaces', () => {
    const vm = buildTokenPlanPurchaseResult(
      makeResult({
        status: 'succeeded',
        activationStatus: 'pending',
        paymentUrl: 'https://pay.test.qianwenai.com/checkout/order-1',
        warning: 'Payment succeeded, but follow-up processing did not complete.',
      }),
    );
    expect(joinLines(vm.lines)).toContain('PAYMENT URL');
    expect(joinLines(vm.lines)).toContain('follow-up processing did not complete');
    expect(vm.lines).toContain('Token Plan activation is not yet confirmed.');
    expect(joinLines(vm.lines)).not.toContain('Activation is in progress');
    expect(vm.data.paymentUrl).toContain('pay.test.qianwenai.com');
    expect(vm.data.warning).toContain('follow-up processing did not complete');
  });

  it('hides settlement drift notice when settlementDrifted is not set', () => {
    const vm = buildTokenPlanPurchaseResult(makeResult());
    const body = joinLines(vm.lines);
    expect(body).not.toContain('reconfirmed funding plan');
  });
});

describe('createTokenPlanPurchaseInteraction text output ownership', () => {
  it('does not write the payment URL to stderr before the final result is rendered', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const interaction = createTokenPlanPurchaseInteraction('text', vi.fn());
      await expect(
        interaction.payment('https://pay.test.qianwenai.com/checkout/order-1', Promise.resolve()),
      ).resolves.toEqual({ skipPolling: true });
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('table prompt accepts a combined choice/return chunk and payment renders its summary', async () => {
    renderInteractiveMock.mockImplementationOnce(async (element) => {
      const prompt = render(element);
      const promptStdin = prompt.stdin as unknown as Record<string, unknown> & NodeJS.EventEmitter;
      if (typeof promptStdin.ref !== 'function') promptStdin.ref = () => {};
      if (typeof promptStdin.unref !== 'function') promptStdin.unref = () => {};
      if (typeof promptStdin.resume !== 'function') promptStdin.resume = () => {};
      promptStdin.setRawMode = vi.fn();
      const pending: string[] = [];
      promptStdin.read = () => pending.shift() ?? null;
      promptStdin.write = (data: string) => {
        pending.push(data);
        promptStdin.emit('readable');
        return true;
      };
      await new Promise<void>((resolve) => setImmediate(resolve));
      promptStdin.write('1\r');
      await new Promise<void>((resolve) => setImmediate(resolve));
      prompt.unmount();
    });
    const reviewInteraction = createTokenPlanPurchaseInteraction('table', vi.fn());
    await expect(reviewInteraction.review(makePreview())).resolves.toEqual({ action: 'confirm' });

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stdinResume = vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    try {
      const interaction = createTokenPlanPurchaseInteraction('table', vi.fn());
      await interaction.payment(
        'https://pay.test.qianwenai.com/checkout/order-1',
        Promise.resolve(),
        {
          expiresAt: Date.parse('2026-09-04T10:30:00.000Z'),
          details: {
            paymentOrderId: '299466212730032',
            type: 'token_plan_individual_standard',
            billingCycle: 'monthly',
            payableAmount: '179.43',
          },
        },
      );
      const output = stdoutWrite.mock.calls.map(([value]) => String(value)).join('');
      expect(output.indexOf('ORDER ID')).toBeLessThan(output.indexOf('Scan with Alipay to pay'));
      expect(output).toContain('PAYABLE AMOUNT');
      expect(output).toContain('¥179.43 CNY');
      expect(output).toContain('CHANNEL               Alipay');
      expect(output).not.toContain('ORDER EXPIRES AT');
      expect(output).not.toContain('token_plan_individual_standard');
      expect(output).toContain(
        'Waiting for payment...\nAfter completing the payment, confirmation may take a few seconds. Please wait.\nCtrl+C stops waiting; it does not cancel the order.',
      );
    } finally {
      stdinResume.mockRestore();
      stdoutWrite.mockRestore();
    }
  });
});

describe('createTokenPlanPurchaseInteraction plain action input', () => {
  for (const format of ['text', 'json'] as const) {
    it.each([
      ['1', 'confirm'],
      ['0', 'cancel'],
    ] as const)(`${format}: empty input waits for explicit %s`, async (choice, action) => {
      questionMock.mockReset();
      closeReaderMock.mockClear();
      questionMock
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('   ')
        .mockResolvedValueOnce('\t')
        .mockResolvedValueOnce(choice);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const interaction = createTokenPlanPurchaseInteraction(format, vi.fn());
        await expect(interaction.review(makePreview())).resolves.toEqual({ action });
        expect(questionMock).toHaveBeenCalledTimes(4);
        expect(
          questionMock.mock.calls.every(
            ([prompt]) => prompt === 'Select an action (0 to cancel): ',
          ),
        ).toBe(true);
        expect(closeReaderMock).toHaveBeenCalledOnce();
      } finally {
        stderr.mockRestore();
      }
    });

    it(`${format}: invalid input and empty deduction return keep the action menu open`, async () => {
      questionMock.mockReset();
      closeReaderMock.mockClear();
      for (const answer of ['9', '', '3', '', '', '0']) questionMock.mockResolvedValueOnce(answer);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await expect(
          createTokenPlanPurchaseInteraction(format, vi.fn()).review(makePreview()),
        ).resolves.toEqual({ action: 'cancel' });
        expect(questionMock).toHaveBeenCalledTimes(6);
        expect(questionMock.mock.calls[3][0]).toContain('empty to go back');
        expect(closeReaderMock).toHaveBeenCalledOnce();
      } finally {
        stderr.mockRestore();
      }
    });

    it(`${format}: coupon submenu retains its existing empty-input cancellation`, async () => {
      questionMock.mockReset();
      closeReaderMock.mockClear();
      questionMock.mockResolvedValueOnce('2').mockResolvedValueOnce('');
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const preview = makePreview({
          quote: makeQuote({ coupons: [{ id: 'coupon-a', name: 'Coupon A', balance: '10.00' }] }),
        });
        await expect(
          createTokenPlanPurchaseInteraction(format, vi.fn()).review(preview),
        ).resolves.toEqual({ action: 'cancel' });
        expect(questionMock).toHaveBeenCalledTimes(2);
        expect(questionMock.mock.calls[1][0]).toBe('Select a coupon (Enter cancels purchase): ');
        expect(closeReaderMock).toHaveBeenCalledOnce();
      } finally {
        stderr.mockRestore();
      }
    });
  }
});
