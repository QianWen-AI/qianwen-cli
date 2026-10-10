/** Unit tests for TokenPlanPaymentService payment response parsing. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeMockApiClient, type MockApiClient } from '../helpers/service-mocks.js';
import { TokenPlanPaymentService } from '../../src/services/tokenplan-payment-service.js';
import type { CallFlatApiOptions, CallOrchestrationApiOptions } from '../../src/api/api-client.js';
import { CliError } from '../../src/utils/errors.js';
import { site } from '../../src/site.js';
import { API_ACTION_QUERY_PAY_RESULT } from '../../src/types/api-routes.js';
import {
  buildTokenPlanPaymentResultViewModel,
  tokenPlanPaymentResultExitCode,
} from '../../src/view-models/subscription/tokenplan-payment.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let api: MockApiClient;
let service: TokenPlanPaymentService;

function flatResponse(response: unknown) {
  api.callFlatApi.mockResolvedValueOnce(response);
}

function teamConfiguration(): Record<string, unknown> {
  return {
    commodityCode: site.features.tokenPlanCommodityCodes.teams,
    specCode: 'standard',
    chargeType: 'PREPAY',
    orderType: 'BUY',
    autoRenew: false,
    quantity: 1,
    duration: '1',
    pricingCycle: 'Month',
    orderParams: {},
    components: [
      {
        componentCode: 'seat',
        instanceProperty: [{ code: 'plan_type', value: 'standard' }],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api = makeMockApiClient();
  service = new TokenPlanPaymentService(api);
});

// ---------------------------------------------------------------------------
// mergePay payment Data wrapper handling
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.useRealTimers();
});

describe('payment preparation and polling boundaries', () => {
  it.each(['credit', 'wechat', 'constructor', '__proto__'])(
    'rejects unsupported payment channel %s before any request',
    async (channel) => {
      await expect(
        service.mergePay({
          paymentOrderId: '1234567890',
          amount: '100',
          balanceDeduction: '0',
          channel,
        }),
      ).rejects.toThrow();
      expect(api.callFlatApi).not.toHaveBeenCalled();
    },
  );

  it('refuses sub-cent cash before any payment request', async () => {
    await expect(
      service.mergePay({ paymentOrderId: '1234567890', amount: '100', balanceDeduction: '1.005' }),
    ).rejects.toThrow();
    expect(api.callFlatApi).not.toHaveBeenCalled();
  });

  it('sends the exact confirmed cash and rounded external remainder', async () => {
    flatResponse({ Success: true, Code: 'Success', PayStatus: 'PAY_DONE', OrderId: '1234567890' });
    await service.mergePay({
      paymentOrderId: '1234567890',
      amount: '100.005',
      balanceDeduction: '1.01',
    });
    const request = api.callFlatApi.mock.calls[0][0] as CallFlatApiOptions;
    const params = JSON.parse(String(request.params?.ParamStr));
    expect(params.cashMoney).toBe('1.01');
    expect(params.fundChargeDTO.amount).toBe('99');
    expect(params.fundChargeDTO).toMatchObject({
      paymentType: 'PcCharge_PG',
      chargeType: 'PcCharge',
      extendInfo: { qrPay: 'true' },
    });
    expect(params.creditMoney).toBeUndefined();
    expect(params.storedCardNo).toBeUndefined();
  });

  it('team settlement must cover all order IDs, not just the first order', async () => {
    flatResponse({
      Success: true,
      Code: 'Success',
      Data: { OrderId: '1234567890', SettleCurrency: 'CNY', SettleTotalPayFee: '30' },
    });
    await expect(
      service.getOrderSettlement('1234567890', undefined, ['1234567890', '1234567891']),
    ).rejects.toThrow();
  });

  it('accepts the sum of complete settlement lines for the created order set', async () => {
    flatResponse({
      Success: true,
      Code: 'Success',
      Data: {
        OrderId: '1234567890',
        SettleCurrency: 'CNY',
        OrderLines: [
          { OrderId: '1234567890', SettleTotalPayFee: '30' },
          { OrderId: '1234567891', SettleTotalPayFee: '50' },
        ],
      },
    });
    await expect(
      service.getOrderSettlement('1234567890', undefined, ['1234567890', '1234567891']),
    ).resolves.toMatchObject({ settledPayable: '80' });
  });

  it.each(['pending', 'transient'] as const)(
    '%s polling uses 3-second intervals and is time-bounded',
    async (state) => {
      vi.useFakeTimers();
      const poll = vi.spyOn(service, 'getPaymentResult');
      if (state === 'pending') poll.mockResolvedValue({ orderId: '1234567890', status: 'pending' });
      else
        poll.mockRejectedValue(
          new CliError({ code: 'RATE_LIMITED', message: 'retry later', exitCode: 5 }),
        );
      const waiting = service.waitForPaymentResult('1234567890', {
        deadlineAt: Date.now() + 15_000,
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await waiting).toMatchObject({ status: 'timed_out' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('a slow read is aborted at the deadline', async () => {
    vi.useFakeTimers();
    const poll = vi.spyOn(service, 'getPaymentResult').mockImplementation(
      (_orderId, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            'abort',
            () => resolve({ orderId: '1234567890', status: 'pending' }),
            { once: true },
          );
        }),
    );
    const waiting = service.waitForPaymentResult('1234567890', {
      deadlineAt: Date.now() + 30_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await waiting).toMatchObject({ status: 'timed_out' });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('interrupting polling never retries or assumes that the payment was cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const recover = vi.spyOn(service, 'recoverPaymentResultFromOrders').mockResolvedValue(null);
    const poll = vi
      .spyOn(service, 'getPaymentResult')
      .mockResolvedValue({ orderId: '1234567890', status: 'pending' });
    const waiting = service.waitForPaymentResult('1234567890', { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await waiting).toMatchObject({ status: 'unknown', reason: 'interrupted' });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one order-list recovery lookup to preserve a confirmed cancellation after interrupt', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(service, 'getPaymentResult').mockResolvedValue({
      orderId: '1234567890',
      status: 'pending',
    });
    const recover = vi.spyOn(service, 'recoverPaymentResultFromOrders').mockResolvedValue({
      orderId: '1234567890',
      status: 'cancelled',
      reason: 'order_cancelled',
    });
    const waiting = service.waitForPaymentResult('1234567890', { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();

    await expect(waiting).resolves.toEqual({
      orderId: '1234567890',
      status: 'cancelled',
      reason: 'order_cancelled',
    });
    expect(recover).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('mergePay — BSS Data wrapper', () => {
  const input = {
    paymentOrderId: '1234567890',
    amount: '39.00',
    balanceDeduction: '0',
  };

  it('maps PAY_NONE in a BSS Data wrapper to pending with a URL', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      Data: {
        PayStatus: 'PAY_NONE',
        AuthUrl: 'https://excashier.alipay.com/pay?id=123',
        OrderId: '1234567890',
      },
    });
    const result = await service.mergePay(input);
    expect(result.status).toBe('pending');
    expect(result.url).toBe('https://excashier.alipay.com/pay?id=123');
  });

  it('maps a valid PayUrl without PayStatus to pending with a URL', async () => {
    flatResponse({ PayUrl: 'https://pay.test.qianwenai.com/qr/team-order' });
    const result = await service.mergePay(input);
    expect(result).toEqual({
      status: 'pending',
      url: 'https://pay.test.qianwenai.com/qr/team-order',
    });
  });

  it('maps PAY_DONE in a BSS Data wrapper to succeeded', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      Data: {
        PayStatus: 'PAY_DONE',
        OrderId: '1234567890',
      },
    });
    const result = await service.mergePay(input);
    expect(result.status).toBe('succeeded');
    expect(result.url).toBeNull();
  });

  it('PAY_DONE combined with a failure code is protocol-unknown', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      Data: {
        PayStatus: 'PAY_DONE',
        PayFailedErrorCode: 'CONFLICTING_FAILURE',
        OrderId: '1234567890',
      },
    });
    await expect(service.mergePay(input)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'protocol_error',
    });
  });

  it('does not treat an unrecognized gateway business code as a confirmed rejection', async () => {
    flatResponse({ Code: 'UNRECOGNIZED_PAYMENT_CODE', Success: false });
    await expect(service.mergePay(input)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'payment_unconfirmed',
    });
  });

  it('preserves a pre-transport failure instead of reporting an uncertain payment write', async () => {
    api.callFlatApi.mockRejectedValueOnce(
      new CliError({
        code: 'AUTH_REQUIRED',
        message: 'Not authenticated.',
        exitCode: 2,
      }),
    );
    await expect(service.mergePay(input)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      exitCode: 2,
    });
  });

  it('maps PAY_FAILED in a BSS Data wrapper to failed', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      Data: {
        PayStatus: 'PAY_FAILED',
        OrderId: '1234567890',
        PayFailedErrorCode: 'INSUFFICIENT_BALANCE',
      },
    });
    const result = await service.mergePay(input);
    expect(result.status).toBe('failed');
  });

  it('does not treat an unrecognized failure field as a confirmed rejection', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      Data: {
        PayStatus: 'PAY_NONE',
        PayFailedErrorCode: 'UNRECOGNIZED_FAILURE',
        OrderId: '1234567890',
      },
    });
    await expect(service.mergePay(input)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'payment_unconfirmed',
    });
  });

  it('maps PAY_NONE in a flat response to pending', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      payStatus: 'PAY_NONE',
      authUrl: 'https://excashier.alipay.com/pay?id=456',
      orderId: '1234567890',
    });
    const result = await service.mergePay(input);
    expect(result.status).toBe('pending');
    expect(result.url).toBe('https://excashier.alipay.com/pay?id=456');
  });
});

// ---------------------------------------------------------------------------
// getPaymentResult payment Data wrapper handling
// ---------------------------------------------------------------------------

describe('getPaymentResult — BSS Data wrapper', () => {
  it('maps PayStatus=1 in a BSS Data wrapper to succeeded', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      Data: {
        PayStatus: '1',
        OrderId: '1234567890',
      },
    });
    const result = await service.getPaymentResult('1234567890');
    expect(result.status).toBe('succeeded');
    expect(result.orderId).toBe('1234567890');
  });

  it('maps PayStatus=0 in a BSS Data wrapper to pending', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      Data: {
        PayStatus: '0',
        OrderId: '1234567890',
      },
    });
    const result = await service.getPaymentResult('1234567890');
    expect(result.status).toBe('pending');
  });

  it('maps PayStatus=1 in a flat response to succeeded', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      PayStatus: '1',
      OrderId: '1234567890',
    });
    const result = await service.getPaymentResult('1234567890');
    expect(result.status).toBe('succeeded');
  });

  it('keeps an unrecognized failure code unknown instead of reporting rejection', async () => {
    flatResponse({
      Code: 'Success',
      Success: true,
      Data: {
        PayStatus: '0',
        PayFailedErrorCode: 'UNRECOGNIZED_FAILURE',
        OrderId: '1234567890',
      },
    });
    await expect(service.getPaymentResult('1234567890')).resolves.toMatchObject({
      status: 'unknown',
      reason: 'payment_unconfirmed',
    });
  });

  it('recovers a canceled payment by exact order ID when payment status is unknown', async () => {
    api.callFlatApi.mockImplementation(async (options: CallFlatApiOptions) => {
      if (options.action === API_ACTION_QUERY_PAY_RESULT) {
        return {
          Code: 'Success',
          Success: true,
          Data: { PayStatus: '2', OrderId: '1234567890' },
        };
      }
      if (options.action === 'QueryAccountBaseInfoApi') return { Data: { NbId: 'NB-99' } };
      if (options.action === 'QueryOrderList') {
        expect(options.params).toMatchObject({
          CurrentPage: 1,
          PageSize: 100,
          OrderType: 'BUY',
          Nbid: 'NB-99',
        });
        return {
          Code: 'Success',
          Success: true,
          Data: [
            { OrderId: '1234567891', OrderStatus: 'CANCELED' },
            { OrderId: '1234567890', OrderStatus: 'CANCELED' },
          ],
        };
      }
      throw new Error(`unexpected action: ${options.action}`);
    });

    await expect(service.getPaymentResult('1234567890')).resolves.toEqual({
      orderId: '1234567890',
      status: 'cancelled',
      reason: 'order_cancelled',
    });
    expect(
      api.callFlatApi.mock.calls.filter(
        ([options]) => (options as CallFlatApiOptions).action === 'QueryOrderList',
      ),
    ).toHaveLength(1);
  });

  it('does not use another canceled order when recovering the requested order', async () => {
    api.callFlatApi.mockImplementation(async (options: CallFlatApiOptions) => {
      if (options.action === API_ACTION_QUERY_PAY_RESULT) {
        return {
          Code: 'Success',
          Success: true,
          Data: { PayStatus: '2', OrderId: '1234567890' },
        };
      }
      if (options.action === 'QueryAccountBaseInfoApi') throw new Error('identity unavailable');
      if (options.action === 'QueryOrderList') {
        expect(options.params).not.toHaveProperty('Nbid');
        return {
          Code: 'Success',
          Success: true,
          Data: [
            { OrderId: '1234567891', OrderStatus: 'CANCELED' },
            { OrderId: '1234567890', OrderStatus: 'UNPAID' },
          ],
        };
      }
      throw new Error(`unexpected action: ${options.action}`);
    });

    await expect(service.getPaymentResult('1234567890')).resolves.toEqual({
      orderId: '1234567890',
      status: 'unknown',
      reason: 'protocol_error',
    });
  });

  it('rejects an order ID outside the numeric API safe range before requesting', async () => {
    await expect(service.getPaymentResult('9007199254740992')).rejects.toMatchObject({
      exitCode: 4,
    });
    expect(api.callFlatApi).not.toHaveBeenCalled();
  });
});

describe('createOrders — team response normalization', () => {
  it('guides users to account settings when real-name authentication is required', async () => {
    api.callOrchestrationApi.mockRejectedValueOnce(
      Object.assign(new Error('NO_REAL_NAME_AUTHENTICATION'), {
        code: 'NO_REAL_NAME_AUTHENTICATION',
      }),
    );

    await expect(service.createOrders([teamConfiguration()])).rejects.toMatchObject({
      code: 'TOKENPLAN_REAL_NAME_REQUIRED',
      message:
        'Real-name authentication is required. Complete it at: https://platform.qianwenai.com/home/settings/account',
    });
  });

  it('accepts equivalent order ID collections in different orders and preserves the primary ID', async () => {
    api.callOrchestrationApi.mockImplementationOnce(
      async (options: CallOrchestrationApiOptions<unknown>) =>
        options.parse({
          Code: 'Success',
          Success: true,
          OrderId: '1234567891',
          OrderIds: ['1234567890', '1234567891'],
          Items: [{ OrderId: '1234567891' }, { OrderId: '1234567890' }],
        }),
    );
    await expect(service.createOrders([teamConfiguration()])).resolves.toEqual({
      paymentOrderId: '1234567891',
      orderIds: ['1234567890', '1234567891'],
    });
  });

  it('rejects duplicate team order IDs', async () => {
    api.callOrchestrationApi.mockImplementationOnce(
      async (options: CallOrchestrationApiOptions<unknown>) =>
        options.parse({
          Code: 'Success',
          Success: true,
          OrderIds: ['1234567890', '1234567890'],
        }),
    );
    await expect(service.createOrders([teamConfiguration()])).rejects.toMatchObject({
      code: 'CREATE_UNKNOWN',
    });
  });
});

describe('payment-result exit codes', () => {
  it.each(['pending', 'unknown', 'timed_out'] as const)(
    'returns task-not-completed for %s',
    (status) => {
      expect(tokenPlanPaymentResultExitCode({ orderId: '1234567890', status })).toBe(8);
    },
  );
  it('keeps succeeded distinct from all non-terminal outcomes', () => {
    expect(tokenPlanPaymentResultExitCode({ orderId: '1234567890', status: 'succeeded' })).toBe(0);
  });

  it('reports a confirmed order cancellation as a terminal unsuccessful result', () => {
    const result = {
      orderId: '1234567890',
      status: 'cancelled',
      reason: 'order_cancelled',
    } as const;
    expect(tokenPlanPaymentResultExitCode(result)).toBe(1);
    expect(buildTokenPlanPaymentResultViewModel(result).fields).toContainEqual({
      label: 'Payment status',
      value: 'Canceled',
    });
  });

  it('keeps protocol reason codes in JSON but renders user guidance in human output', () => {
    const vm = buildTokenPlanPaymentResultViewModel({
      orderId: '1234567890',
      status: 'unknown',
      reason: 'protocol_error',
      payStatusCode: '0',
    });
    expect(vm.data).toMatchObject({ reason: 'protocol_error', payStatusCode: '0' });
    expect(vm.fields).toEqual([
      { label: 'Order ID', value: '1234567890' },
      { label: 'Payment status', value: 'Unknown' },
      {
        label: 'Next step',
        value:
          'Do not pay again. Check the order first: qianwen subscription orders --type purchase',
      },
    ]);
  });
});
