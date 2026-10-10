/** Unit tests for TokenPlanPurchaseGates – payment capabilities & identity. */
import { describe, it, expect, vi } from 'vitest';
import { TokenPlanPurchaseGates } from '../../src/services/tokenplan-purchase-gates.js';
import { makeMockApiClient } from '../helpers/service-mocks.js';
import { createApiClient } from '../../src/api/api-client.js';
import type { CallFlatApiOptions } from '../../src/api/api-client.js';
import type { RequestOptions } from '../../src/api/base-client.js';
import type { RawApiEnvelope } from '../../src/types/api-envelope.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function humanResponse(site: string, nbid: string) {
  return {
    Success: true,
    Code: 'Success',
    Data: {
      SellerInfoDto: { Site: site, Nbid: nbid },
    },
  };
}

function paymentMethodResponse(inner: unknown[] = [], biz: unknown[] = []) {
  return {
    RequestId: 'synthetic-request',
    CreditUser: false,
    UserType: 'synthetic-user-type',
    InnerPaymentMethodList: inner,
    BizPaymentMethodList: biz,
  };
}

function cashItem(overrides?: Record<string, unknown>) {
  return {
    PaymentMethodType: 'LEGACY_ACCT_BOOK',
    BookNo: 'BOOK-001',
    PaymentMethodAvailableAmount: '500.00',
    Currency: 'CNY',
    ...overrides,
  };
}

function creditItem(type = 'QUOTA_BOOK') {
  return { PaymentMethodType: type, BookNo: 'CREDIT-001' };
}

function pcChargeItem() {
  return {
    PaymentTypeConfigList: [{ PaymentType: 'PcCharge_PG' }],
  };
}

type FlatHandler = (opts: CallFlatApiOptions) => Promise<unknown>;

describe('individual subscription purchase admission', () => {
  const expired = {
    status: 'INVALID',
    instanceCode: 'expired-instance',
    specCode: 'essential',
    remainingDays: 0,
    autoRenewFlag: false,
    startTime: 1,
    endTime: 2,
  };

  function accountGates(business: unknown, responses: Record<string, unknown> = {}) {
    return new TokenPlanPurchaseGates(
      makeMockApiClient({
        csData: async (options) => {
          if (business instanceof Error) throw business;
          return options.parse(business);
        },
        flat: async (options) => {
          if (Object.hasOwn(responses, options.action)) return responses[options.action];
          if (options.action === 'LoadHumanInfo') return humanResponse('china-site', 'nb-123');
          if (options.action === 'QueryOrderList')
            return { Success: true, TotalCount: 0, Data: [] };
          if (options.action === 'QuerySubscriptionGray') return { Success: true, IsGray: true };
          if (options.action === 'GetBillingAccountAvailableAmount')
            return { AvailableAmount: '0' };
          throw new Error('Unexpected account check');
        },
      }),
    );
  }

  it.each([
    { data: undefined },
    { data: null },
    { data: {} },
    { data: { status: 'INVALID' } },
    { data: { status: 'UNKNOWN' } },
    { success: false },
    { success: undefined },
    { code: 'FAILED' },
    { code: undefined },
  ])(
    'matches the frontend by treating every non-VALID subscription as inactive: %j',
    async (partial) => {
      const gates = accountGates({ success: true, code: 'SUCCESS', ...partial });
      await expect(gates.checkAccount('individual')).resolves.toBeUndefined();
    },
  );

  it('admits the confirmed no-data response only after the other account checks succeed', async () => {
    await expect(
      accountGates({ code: 'SUCCESS', success: true }).checkAccount('individual'),
    ).resolves.toBeUndefined();
  });

  it('matches the frontend by allowing a failed individual subscription query', async () => {
    await expect(
      accountGates(new Error('subscription unavailable')).checkAccount('individual'),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      action: 'QueryOrderList',
      response: { Success: true, Data: [] },
      code: 'TOKENPLAN_ORDERS_UNKNOWN',
    },
    {
      action: 'QueryOrderList',
      response: {
        Success: true,
        TotalCount: 1,
        Data: [{ CommodityCode: 'sfm_tokenplansolo_public_cn', OrderStatus: 'UNPAID' }],
      },
      code: 'TOKENPLAN_UNPAID_ORDER',
    },
    {
      action: 'QuerySubscriptionGray',
      response: { Success: true },
      code: 'TOKENPLAN_ELIGIBILITY_UNKNOWN',
    },
    {
      action: 'QuerySubscriptionGray',
      response: { Success: true, IsGray: false },
      code: 'TOKENPLAN_NOT_ELIGIBLE',
    },
  ])(
    'a confirmed no-data response cannot override $action: $code',
    async ({ action, response, code }) => {
      await expect(
        accountGates(
          { code: 'SUCCESS', success: true },
          {
            [action]: response,
          },
        ).checkAccount('individual'),
      ).rejects.toMatchObject({
        code,
        ...(code === 'TOKENPLAN_UNPAID_ORDER'
          ? {
              message:
                'An unpaid Token Plan order already exists for this plan type.\nTo complete the payment, cancel the order, or view its details, visit:\nhttps://platform.qianwenai.com/home/billing/subscription',
            }
          : {}),
      });
    },
  );

  it('matches the frontend by treating a complete expired INVALID subscription as inactive', async () => {
    await expect(
      accountGates({ success: true, code: 'SUCCESS', data: expired }).checkAccount('individual'),
    ).resolves.toBeUndefined();
  });

  it.each([{ AvailableAmount: '-0.01' }, { AvailableAmount: -0.01 }])(
    'blocks an account with a negative billing balance before purchase: %j',
    async (response) => {
      await expect(
        accountGates(
          { code: 'SUCCESS', success: true },
          {
            GetBillingAccountAvailableAmount: response,
          },
        ).checkAccount('individual'),
      ).rejects.toMatchObject({
        code: 'TOKENPLAN_ACCOUNT_IN_ARREARS',
        message:
          "Your account balance is below 0. Run 'qianwen billing balance recharge' to recharge before purchasing a Token Plan.",
        exitCode: 1,
      });
    },
  );

  it.each([
    { AvailableAmount: null },
    { AvailableAmount: 'invalid' },
    { AvailableAmount: 1e21 },
    { Success: false, AvailableAmount: '-1' },
  ])('keeps an untrusted billing balance fail-closed: %j', async (response) => {
    await expect(
      accountGates(
        { code: 'SUCCESS', success: true },
        {
          GetBillingAccountAvailableAmount: response,
        },
      ).checkAccount('individual'),
    ).rejects.toMatchObject({ code: 'TOKENPLAN_ACCOUNT_BALANCE_UNKNOWN', exitCode: 4 });
  });
});

describe('team subscription purchase admission', () => {
  const commodity = 'sfm_tokenplanteams_dp_cn';
  function accountGates(summary: unknown | Error) {
    const flatFn = vi.fn(async (options: CallFlatApiOptions) => {
      if (options.action === 'GetBillingAccountAvailableAmount') {
        return { AvailableAmount: '0' };
      }
      if (options.action === 'GetUserInstanceSummary') {
        if (summary instanceof Error) throw summary;
        return summary;
      }
      if (options.action === 'LoadHumanInfo') return humanResponse('china-site', 'nb-123');
      if (options.action === 'QueryOrderList') {
        return { Success: true, Code: '200', CurrentPage: 1, PageSize: 1, TotalCount: 0, Data: [] };
      }
      if (options.action === 'QuerySubscriptionGray') return { IsGray: true };
      throw new Error(`Unexpected account check: ${options.action}`);
    });
    return {
      flatFn,
      gates: new TokenPlanPurchaseGates(makeMockApiClient({ flat: flatFn })),
    };
  }

  it('blocks the purchase when the frontend summary reports a matching active instance', async () => {
    const { gates } = accountGates({
      Data: [{ ProductCode: commodity, InstanceCodeList: ['synthetic-instance'] }],
    });
    await expect(gates.checkAccount('team')).rejects.toMatchObject({
      code: 'TOKENPLAN_ACTIVE_SUBSCRIPTION',
    });
  });

  it.each([
    { Data: [] },
    { Data: [{ SpecType: 'standard', Quantity: 0 }] },
    { Success: false },
    new Error('summary unavailable'),
  ])('matches the frontend by allowing an unconfirmed inactive summary: %j', async (summary) => {
    const { gates, flatFn } = accountGates(summary);

    await expect(gates.checkAccount('team')).resolves.toBeUndefined();
    expect(
      flatFn.mock.calls.some(
        ([options]) => (options as CallFlatApiOptions).action === 'DescribeFrInstances',
      ),
    ).toBe(false);
  });
});

describe('TokenPlanPurchaseGates.checkAccount', () => {
  it.each([
    {
      edition: 'individual' as const,
      url: 'https://platform.qianwenai.com/home/analytics/token-plan/individual',
    },
    {
      edition: 'team' as const,
      url: 'https://platform.qianwenai.com/home/analytics/token-plan/team',
    },
  ])(
    'guides an already-subscribed $edition user to the matching console',
    async ({ edition, url }) => {
      const gates = new TokenPlanPurchaseGates(makeMockApiClient());
      vi.spyOn(gates, 'getAvailability').mockResolvedValue({
        available: false,
        reason: 'TOKENPLAN_ACTIVE_SUBSCRIPTION',
      });

      await expect(gates.checkAccount(edition)).rejects.toMatchObject({
        code: 'TOKENPLAN_ACTIVE_SUBSCRIPTION',
        message: `An active Token Plan subscription already exists for this edition. View subscription: ${url}`,
        exitCode: 1,
      });
    },
  );
});

function buildGatesWithFlat(handler: FlatHandler) {
  const apiClient = makeMockApiClient({ flat: handler });
  const gates = new TokenPlanPurchaseGates(apiClient);
  return { gates, apiClient };
}

// ---------------------------------------------------------------------------
// getPaymentCapabilities
// ---------------------------------------------------------------------------

describe('TokenPlanPurchaseGates.getPaymentCapabilities', () => {
  function buildGatesWithEnvelope(paymentEnvelope: RawApiEnvelope<unknown>) {
    const request = vi.fn(async <Response>(options: RequestOptions): Promise<Response> => {
      const body = JSON.parse(options.body ?? '{}') as { action?: string };
      if (body.action === 'LoadHumanInfo') {
        return { code: '200', data: humanResponse('china-site', 'nb-123') } as Response;
      }
      if (body.action === 'GetUserPaymentMethod') return paymentEnvelope as Response;
      throw new Error(`Unexpected action: ${body.action}`);
    });
    const gates = new TokenPlanPurchaseGates(createApiClient({ baseClient: { request } }));
    return { gates, request };
  }

  it.each(['individual', 'team'] as const)(
    '%s accepts gateway-confirmed payment methods without inner success markers',
    async (edition) => {
      const { gates, request } = buildGatesWithEnvelope({
        code: '200',
        data: paymentMethodResponse([cashItem()], [pcChargeItem()]),
      });
      await expect(gates.getPaymentCapabilities(edition)).resolves.toMatchObject({
        admissionResult: 'supported',
        cashMethod: { available: '500', currency: 'CNY' },
        alipayScanning: true,
        identityContext: { site: 'china-site', nbid: 'nb-123' },
      });
      expect(
        request.mock.calls.map(([options]) => {
          const body = JSON.parse(options.body ?? '{}') as { action?: string };
          return body.action;
        }),
      ).toEqual(['LoadHumanInfo', 'GetUserPaymentMethod']);
    },
  );

  it.each(['individual', 'team'] as const)(
    '%s still rejects gateway failure despite a complete payment payload',
    async (edition) => {
      const { gates } = buildGatesWithEnvelope({
        code: '500',
        data: paymentMethodResponse([cashItem()], [pcChargeItem()]),
      });
      await expect(gates.getPaymentCapabilities(edition)).rejects.toMatchObject({
        name: 'CliError',
        code: 'TOKENPLAN_CHECK_UNKNOWN',
        exitCode: 4,
      });
    },
  );

  it('a complete no-cash response supports pure Alipay', async () => {
    const { gates } = buildGatesWithFlat(async (opts) =>
      opts.action === 'LoadHumanInfo'
        ? humanResponse('china-site', 'nb-123')
        : {
            Success: true,
            Data: { InnerPaymentMethodList: [], BizPaymentMethodList: [pcChargeItem()] },
          },
    );
    await expect(gates.getPaymentCapabilities('individual')).resolves.toMatchObject({
      admissionResult: 'supported',
      cashMethod: null,
      alipayScanning: true,
    });
  });

  it('malformed cash is not converted into a zero-cash Alipay account', async () => {
    const { gates } = buildGatesWithFlat(async (opts) =>
      opts.action === 'LoadHumanInfo'
        ? humanResponse('china-site', 'nb-123')
        : paymentMethodResponse(
            [cashItem({ PaymentMethodAvailableAmount: null })],
            [pcChargeItem()],
          ),
    );
    await expect(gates.getPaymentCapabilities('individual')).rejects.toMatchObject({
      code: 'TOKENPLAN_PAYMENT_CAPABILITY_UNKNOWN',
    });
  });

  it('normal cash account returns supported', async () => {
    const { gates } = buildGatesWithFlat(async (opts) => {
      if (opts.action === 'LoadHumanInfo') return humanResponse('china-site', 'nb-123');
      if (opts.action === 'GetUserPaymentMethod')
        return paymentMethodResponse([cashItem()], [pcChargeItem()]);
      throw new Error(`Unexpected action: ${opts.action}`);
    });

    const result = await gates.getPaymentCapabilities('individual');
    expect(result.admissionResult).toBe('supported');
    expect(result.cashMethod).toEqual({ available: '500', currency: 'CNY' });
    expect(result.alipayScanning).toBe(true);
    expect(result.identityContext).toEqual({ site: 'china-site', nbid: 'nb-123' });
  });

  it('credit account (QUOTA_BOOK) throws TOKENPLAN_CREDIT_NOT_SUPPORTED', async () => {
    const { gates } = buildGatesWithFlat(async (opts) => {
      if (opts.action === 'LoadHumanInfo') return humanResponse('china-site', 'nb-123');
      if (opts.action === 'GetUserPaymentMethod')
        return paymentMethodResponse([cashItem(), creditItem('QUOTA_BOOK')], []);
      throw new Error(`Unexpected action: ${opts.action}`);
    });

    await expect(gates.getPaymentCapabilities('individual')).rejects.toMatchObject({
      code: 'TOKENPLAN_CREDIT_NOT_SUPPORTED',
      message:
        'Your account uses credit-based payment, which the CLI does not support. Purchase at: https://platform.qianwenai.com/pricing/token-plan',
    });
  });

  it('credit account (LEGACY_CREDIT_ACCT_BOOK) throws TOKENPLAN_CREDIT_NOT_SUPPORTED', async () => {
    const { gates } = buildGatesWithFlat(async (opts) => {
      if (opts.action === 'LoadHumanInfo') return humanResponse('china-site', 'nb-123');
      if (opts.action === 'GetUserPaymentMethod')
        return paymentMethodResponse([creditItem('LEGACY_CREDIT_ACCT_BOOK')], []);
      throw new Error(`Unexpected action: ${opts.action}`);
    });

    await expect(gates.getPaymentCapabilities('individual')).rejects.toMatchObject({
      code: 'TOKENPLAN_CREDIT_NOT_SUPPORTED',
      message:
        'Your account uses credit-based payment, which the CLI does not support. Purchase at: https://platform.qianwenai.com/pricing/token-plan',
    });
  });

  it('missing identity (empty site) throws TOKENPLAN_PAYMENT_CAPABILITY_UNKNOWN', async () => {
    const { gates } = buildGatesWithFlat(async (opts) => {
      if (opts.action === 'LoadHumanInfo')
        return { Success: true, Code: 'Success', Data: { SellerInfoDto: {} } };
      throw new Error(`Unexpected action: ${opts.action}`);
    });

    await expect(gates.getPaymentCapabilities('individual')).rejects.toThrow(
      /Could not determine payment capabilities/,
    );
  });

  it('loadIdentity does not re-call LoadHumanInfo within the same instance and round', async () => {
    const flatFn = vi.fn(async (opts: CallFlatApiOptions) => {
      if (opts.action === 'LoadHumanInfo') return humanResponse('s', 'n');
      if (opts.action === 'GetUserPaymentMethod')
        return paymentMethodResponse([cashItem()], [pcChargeItem()]);
      // For checkAccount calls we need to provide enough mock data
      if (opts.action === 'GetFundAccountAvailableAmount')
        return { Success: true, SettleCurrency: 'CNY', AvailableAmount: '100' };
      return { Success: true, Code: 'Success' };
    });
    const apiClient = makeMockApiClient({ flat: flatFn });
    const gates = new TokenPlanPurchaseGates(apiClient);

    // getPaymentCapabilities calls loadIdentity, then calls GetUserPaymentMethod
    await gates.getPaymentCapabilities('individual');

    // Count LoadHumanInfo calls — should be exactly 1
    const humanCalls = flatFn.mock.calls.filter(
      (call) => (call[0] as CallFlatApiOptions).action === 'LoadHumanInfo',
    );
    expect(humanCalls).toHaveLength(1);
  });

  it('multiple getPaymentCapabilities calls on the same instance invoke LoadHumanInfo only once', async () => {
    const flatFn = vi.fn(async (opts: CallFlatApiOptions) => {
      if (opts.action === 'LoadHumanInfo') return humanResponse('china-site', 'nb-123');
      if (opts.action === 'GetUserPaymentMethod')
        return paymentMethodResponse([cashItem()], [pcChargeItem()]);
      return { Success: true, Code: 'Success' };
    });
    const apiClient = makeMockApiClient({ flat: flatFn });
    const gates = new TokenPlanPurchaseGates(apiClient);

    // Call getPaymentCapabilities multiple times on the same instance
    await gates.getPaymentCapabilities('individual');
    await gates.getPaymentCapabilities('team');
    await gates.getPaymentCapabilities('individual');

    // LoadHumanInfo should only have been called once due to identity caching
    const humanCalls = flatFn.mock.calls.filter(
      (call) => (call[0] as CallFlatApiOptions).action === 'LoadHumanInfo',
    );
    expect(humanCalls).toHaveLength(1);
  });

  it('individual edition sends soloBuy SkuCodeList', async () => {
    const flatFn = vi.fn(async (opts: CallFlatApiOptions) => {
      if (opts.action === 'LoadHumanInfo') return humanResponse('china-site', 'nb-123');
      if (opts.action === 'GetUserPaymentMethod')
        return paymentMethodResponse([cashItem()], [pcChargeItem()]);
      return { Success: true, Code: 'Success' };
    });
    const apiClient = makeMockApiClient({ flat: flatFn });
    const gates = new TokenPlanPurchaseGates(apiClient);

    await gates.getPaymentCapabilities('individual');

    const paymentCall = flatFn.mock.calls.find(
      (call) => (call[0] as CallFlatApiOptions).action === 'GetUserPaymentMethod',
    );
    expect(paymentCall).toBeDefined();
    const params = (paymentCall![0] as CallFlatApiOptions).params;
    expect(params).toHaveProperty('SkuCodeList');
    expect(JSON.parse(params!.SkuCodeList as string)).toContain('sfm_tokenplansolo_public_cn');
  });

  it('team edition sends teams SkuCodeList', async () => {
    const flatFn = vi.fn(async (opts: CallFlatApiOptions) => {
      if (opts.action === 'LoadHumanInfo') return humanResponse('china-site', 'nb-123');
      if (opts.action === 'GetUserPaymentMethod')
        return paymentMethodResponse([cashItem()], [pcChargeItem()]);
      return { Success: true, Code: 'Success' };
    });
    const apiClient = makeMockApiClient({ flat: flatFn });
    const gates = new TokenPlanPurchaseGates(apiClient);

    await gates.getPaymentCapabilities('team');

    const paymentCall = flatFn.mock.calls.find(
      (call) => (call[0] as CallFlatApiOptions).action === 'GetUserPaymentMethod',
    );
    expect(paymentCall).toBeDefined();
    const params = (paymentCall![0] as CallFlatApiOptions).params;
    expect(params).toHaveProperty('SkuCodeList');
    expect(JSON.parse(params!.SkuCodeList as string)).toContain('sfm_tokenplanteams_dp_cn');
  });
});
