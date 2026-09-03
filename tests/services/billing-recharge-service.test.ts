import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallFlatApiOptions } from '../../src/api/api-client.js';
import { ResponseParseError } from '../../src/api/base-client.js';
import {
  BillingService,
  RECHARGE_POLL_TIMEOUT_MS,
  RechargeCreateUnknownError,
  RechargeOrderNotFoundError,
  isTransientRechargeGatewayFailure,
  type BillingAdapter,
} from '../../src/services/billing-service.js';
import { makeMockApiClient, makeMockCachedFetcher } from '../helpers/service-mocks.js';

const NBID = 'nbid-sensitive-test-value';
const ORDER_ID = 'order-300000000000000001';
const PAYMENT_URL = 'https://pay.test.qianwenai.com/checkout/order-1';

const billingAdapter: BillingAdapter = {
  toNormalizedItem: () => null,
};

function identityResponse(nbid = NBID): unknown {
  return {
    Success: true,
    Data: { SellerInfoDto: { Nbid: nbid } },
  };
}

function createService(handler: (options: CallFlatApiOptions) => Promise<unknown>): {
  service: BillingService;
  callFlatApi: ReturnType<typeof makeMockApiClient>['callFlatApi'];
} {
  const api = makeMockApiClient({ flat: handler });
  return {
    service: new BillingService(api, billingAdapter, makeMockCachedFetcher()),
    callFlatApi: api.callFlatApi,
  };
}

function gatewayError(message: string, code?: string): Error {
  const error = new Error(message);
  error.name = 'GatewayEnvelopeError';
  if (code !== undefined) Reflect.set(error, 'code', code);
  return error;
}

function actionsOf(callFlatApi: ReturnType<typeof makeMockApiClient>['callFlatApi']): string[] {
  return callFlatApi.mock.calls.map(([options]) => (options as CallFlatApiOptions).action);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BillingService recharge creation', () => {
  it('calls identity, account status, and creation APIs in order with complete Type A parameters', async () => {
    const calls: CallFlatApiOptions[] = [];
    const { service, callFlatApi } = createService(async (options) => {
      calls.push(options);
      if (options.action === 'LoadHumanInfo') return identityResponse();
      if (options.action === 'GetBillingAccountBizStatus') {
        return { Data: { is_limit_charge: 'false' } };
      }
      if (options.action === 'GetRechargeUrl') {
        return { ChargeOrderId: ORDER_ID, RechargeUrl: PAYMENT_URL };
      }
      throw new Error(`unexpected action: ${options.action}`);
    });

    await expect(service.createRecharge({ channel: 'alipay', amount: '1.2' })).resolves.toEqual({
      type: 'recharge',
      channel: 'alipay',
      amount: '1.20',
      currency: 'CNY',
      status: 'pending',
      rechargeOrderId: ORDER_ID,
      paymentUrl: PAYMENT_URL,
    });

    expect(actionsOf(callFlatApi)).toEqual([
      'LoadHumanInfo',
      'GetBillingAccountBizStatus',
      'GetRechargeUrl',
    ]);
    expect(calls).toEqual([
      { product: 'ea-service', action: 'LoadHumanInfo', params: {} },
      {
        product: 'BssOpenAPI-V3',
        action: 'GetBillingAccountBizStatus',
        params: { Nbid: NBID, BizKeys: ['is_limit_charge'] },
      },
      {
        product: 'BssOpenAPI-V3',
        action: 'GetRechargeUrl',
        params: {
          Nbid: NBID,
          Money: '1.20',
          UmId: '',
          ClientVersion: '3.0',
          ClientCode: 'MaasPC',
          RechargeTarget: 'BOOK_ALIYUN_CASH',
          PaymentType: 'PcCharge_PG',
          ExtendInfo: { qrPay: 'true' },
        },
      },
    ]);
  });

  it.each([
    ['true', 'not allowed'],
    ['unknown', 'Unable to confirm'],
  ])(
    'does not create an order when the account restriction value is %s',
    async (limitValue, message) => {
      const { service, callFlatApi } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        if (options.action === 'GetBillingAccountBizStatus') {
          return { Data: { is_limit_charge: limitValue } };
        }
        throw new Error('GetRechargeUrl must not be called');
      });

      await expect(service.createRecharge({ channel: 'alipay', amount: '10' })).rejects.toThrow(
        message,
      );
      expect(actionsOf(callFlatApi)).not.toContain('GetRechargeUrl');
    },
  );

  it('does not query account status or create an order when the identity response lacks Nbid', async () => {
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') {
        return { Success: true, Data: { SellerInfoDto: {} } };
      }
      throw new Error('later API must not be called');
    });

    await expect(service.createRecharge({ channel: 'alipay', amount: '10' })).rejects.toThrow(
      'Data.SellerInfoDto.Nbid',
    );
    expect(actionsOf(callFlatApi)).toEqual(['LoadHumanInfo']);
  });

  it('does not call the creation API when the account status query fails', async () => {
    const statusError = new Error('status unavailable');
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      if (options.action === 'GetBillingAccountBizStatus') throw statusError;
      throw new Error('GetRechargeUrl must not be called');
    });

    await expect(service.createRecharge({ channel: 'alipay', amount: '10' })).rejects.toBe(
      statusError,
    );
    expect(actionsOf(callFlatApi)).toEqual(['LoadHumanInfo', 'GetBillingAccountBizStatus']);
  });

  it.each([
    ['HTTP 408 Request Timeout', 'Error'],
    ['HTTP 429 Too Many Requests', 'Error'],
    ['HTTP 503 Service Unavailable', 'Error'],
    ['fetch failed: socket closed', 'TypeError'],
  ])(
    'calls creation once and marks CREATE_UNKNOWN for uncertain error %s',
    async (message, name) => {
      const failure = name === 'TypeError' ? new TypeError(message) : new Error(message);
      const { service, callFlatApi } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        if (options.action === 'GetBillingAccountBizStatus') {
          return { Data: { is_limit_charge: 'false' } };
        }
        if (options.action === 'GetRechargeUrl') throw failure;
        throw new Error(`unexpected action: ${options.action}`);
      });

      const error = await service
        .createRecharge({ channel: 'alipay', amount: '10' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RechargeCreateUnknownError);
      expect((error as RechargeCreateUnknownError).cause).toBe(failure);
      expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeUrl')).toHaveLength(
        1,
      );
    },
  );

  it('wraps an HTTP-success creation response parse failure as CREATE_UNKNOWN without retrying', async () => {
    const parseError = new ResponseParseError(new SyntaxError('Unexpected end of JSON input'));
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      if (options.action === 'GetBillingAccountBizStatus') {
        return { Data: { is_limit_charge: 'false' } };
      }
      throw parseError;
    });

    const error = await service
      .createRecharge({ channel: 'alipay', amount: '10' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RechargeCreateUnknownError);
    expect((error as RechargeCreateUnknownError).cause).toBe(parseError);
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeUrl')).toHaveLength(1);
  });

  it('preserves an explicit HTTP 400 creation failure without retrying', async () => {
    const failure = new Error('HTTP 400 Bad Request');
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      if (options.action === 'GetBillingAccountBizStatus') {
        return { Data: { is_limit_charge: 'false' } };
      }
      throw failure;
    });

    await expect(service.createRecharge({ channel: 'alipay', amount: '10' })).rejects.toBe(failure);
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeUrl')).toHaveLength(1);
  });

  it.each([
    [{ RechargeUrl: PAYMENT_URL }, 'ChargeOrderId'],
    [{ ChargeOrderId: ORDER_ID }, 'RechargeUrl'],
    [{ ChargeOrderId: ORDER_ID, RechargeUrl: 'https://evil.test/order' }, 'not allowed'],
    [{ ChargeOrderId: ORDER_ID, RechargeUrl: ` ${PAYMENT_URL}` }, 'Invalid payment URL'],
  ])(
    'marks CREATE_UNKNOWN when the successful creation response is unusable: %s',
    async (createResponse, causeMessage) => {
      const { service, callFlatApi } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        if (options.action === 'GetBillingAccountBizStatus') {
          return { Data: { is_limit_charge: 'false' } };
        }
        return createResponse;
      });

      const error = await service
        .createRecharge({ channel: 'alipay', amount: '10' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RechargeCreateUnknownError);
      expect((error as RechargeCreateUnknownError).cause).toBeInstanceOf(Error);
      expect(((error as RechargeCreateUnknownError).cause as Error).message).toContain(
        causeMessage,
      );
      expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeUrl')).toHaveLength(
        1,
      );
    },
  );
});

describe('BillingService single recharge result query', () => {
  it.each(['WAIT', 'DONE', 'FUND_FAILED', 'CANCEL'])(
    'returns known status %s unchanged with a single query',
    async (status) => {
      const controller = new AbortController();
      const { service, callFlatApi } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        if (options.action === 'GetRechargeResult') return { RechargeStatus: status };
        throw new Error(`unexpected action: ${options.action}`);
      });

      await expect(
        service.getRechargeResult({ rechargeOrderId: ORDER_ID, signal: controller.signal }),
      ).resolves.toEqual({
        type: 'recharge',
        rechargeOrderId: ORDER_ID,
        RechargeStatus: status,
      });
      expect(actionsOf(callFlatApi)).toEqual(['LoadHumanInfo', 'GetRechargeResult']);
      expect(callFlatApi.mock.calls[1]?.[0]).toEqual({
        product: 'BssOpenAPI-V3',
        action: 'GetRechargeResult',
        params: { Nbid: NBID, ChargeOrderId: ORDER_ID },
        signal: controller.signal,
      });
    },
  );

  it('preserves an unrecognized status and adds a reason', async () => {
    const { service } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      return { RechargeStatus: 'FUTURE_STATUS' };
    });

    await expect(
      service.getRechargeResult({
        rechargeOrderId: ORDER_ID,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      type: 'recharge',
      rechargeOrderId: ORDER_ID,
      RechargeStatus: 'FUTURE_STATUS',
      reason: 'unrecognized_status',
    });
  });

  it.each([{}, { RechargeStatus: '' }, { RechargeStatus: 123 }])(
    'fails immediately when RechargeStatus is missing or invalid: %s',
    async (response) => {
      const { service, callFlatApi } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        return response;
      });

      await expect(
        service.getRechargeResult({
          rechargeOrderId: ORDER_ID,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Invalid recharge API response: RechargeStatus.');
      expect(actionsOf(callFlatApi)).toEqual(['LoadHumanInfo', 'GetRechargeResult']);
    },
  );

  it('returns interrupted without accessing the API when already aborted before the call', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('SIGINT', 'AbortError'));
    const { service, callFlatApi } = createService(async () => {
      throw new Error('API must not be called');
    });

    await expect(
      service.getRechargeResult({ rechargeOrderId: ORDER_ID, signal: controller.signal }),
    ).resolves.toEqual({
      type: 'recharge',
      rechargeOrderId: ORDER_ID,
      RechargeStatus: 'UNKNOWN',
      reason: 'interrupted',
    });
    expect(callFlatApi).not.toHaveBeenCalled();
  });

  it('does not query the order result when interrupted after identity loading', async () => {
    const controller = new AbortController();
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') {
        controller.abort(new DOMException('SIGINT', 'AbortError'));
        return identityResponse();
      }
      throw new Error('GetRechargeResult must not be called');
    });

    await expect(
      service.getRechargeResult({ rechargeOrderId: ORDER_ID, signal: controller.signal }),
    ).resolves.toMatchObject({ RechargeStatus: 'UNKNOWN', reason: 'interrupted' });
    expect(actionsOf(callFlatApi)).toEqual(['LoadHumanInfo']);
  });

  it.each([
    'The request processing has failed due to some unknown error.',
    '  the REQUEST processing has failed due to some unknown error  ',
  ])(
    'maps the exact generic gateway message to RechargeOrderNotFoundError: %s',
    async (message) => {
      const upstream = gatewayError(message);
      const { service, callFlatApi } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        throw upstream;
      });

      const error = await service
        .getRechargeResult({ rechargeOrderId: ORDER_ID, signal: new AbortController().signal })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RechargeOrderNotFoundError);
      expect((error as RechargeOrderNotFoundError).cause).toBe(upstream);
      expect(actionsOf(callFlatApi)).toEqual(['LoadHumanInfo', 'GetRechargeResult']);
    },
  );

  it.each([
    gatewayError('The request processing has failed due to another error.'),
    Object.assign(new Error('The request processing has failed due to some unknown error.'), {
      name: 'Error',
    }),
  ])(
    'does not misclassify similar messages or other error types as NOT_FOUND',
    async (upstream) => {
      const { service } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        throw upstream;
      });

      await expect(
        service.getRechargeResult({
          rechargeOrderId: ORDER_ID,
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(upstream);
    },
  );
});

describe('BillingService recharge result wait mode', () => {
  it('polls all processing statuses at five-second intervals and stops after DONE', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const statuses = [
      'WAIT',
      'CHARGE_BACK',
      'ACCTBOOK_SUCCESS',
      'BIZACTION_SUCCESS',
      'BIZNOTIFY_SUCCESS',
      'DONE',
    ];
    const queryTimes: number[] = [];
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      queryTimes.push(Date.now());
      return { RechargeStatus: statuses.shift() };
    });

    const resultPromise = service.waitForRechargeResult({
      rechargeOrderId: ORDER_ID,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(25_000);

    await expect(resultPromise).resolves.toMatchObject({ RechargeStatus: 'DONE' });
    expect(queryTimes).toEqual([
      Date.parse('2026-08-25T00:00:00.000Z'),
      Date.parse('2026-08-25T00:00:05.000Z'),
      Date.parse('2026-08-25T00:00:10.000Z'),
      Date.parse('2026-08-25T00:00:15.000Z'),
      Date.parse('2026-08-25T00:00:20.000Z'),
      Date.parse('2026-08-25T00:00:25.000Z'),
    ]);
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult')).toHaveLength(
      6,
    );
    expect(actionsOf(callFlatApi)).not.toContain('GetRechargeUrl');
  });

  it.each(['FUND_FAILED', 'CANCEL', 'FUTURE_STATUS'])(
    'stops immediately for terminal or unrecognized status %s without sleeping or retrying',
    async (status) => {
      vi.useFakeTimers();
      const { service, callFlatApi } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        return { RechargeStatus: status };
      });

      const result = await service.waitForRechargeResult({
        rechargeOrderId: ORDER_ID,
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        type: 'recharge',
        rechargeOrderId: ORDER_ID,
        RechargeStatus: status,
        ...(status === 'FUTURE_STATUS' ? { reason: 'unrecognized_status' } : {}),
      });
      expect(
        actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult'),
      ).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('fails immediately on an HTTP-success response parse failure without sleeping or retrying', async () => {
    vi.useFakeTimers();
    const parseError = new ResponseParseError(new SyntaxError('Unexpected end of JSON input'));
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      throw parseError;
    });

    const resultPromise = service.waitForRechargeResult({
      rechargeOrderId: ORDER_ID,
      signal: new AbortController().signal,
    });

    await expect(resultPromise).rejects.toBe(parseError);
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult')).toHaveLength(
      1,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['HTTP 408 Request Timeout', 'HTTP 429 Too Many Requests', 'HTTP 503 Unavailable'])(
    'waits and safely retries after transient read-only error %s',
    async (message) => {
      vi.useFakeTimers();
      let queryCount = 0;
      const { service, callFlatApi } = createService(async (options) => {
        if (options.action === 'LoadHumanInfo') return identityResponse();
        queryCount += 1;
        if (queryCount === 1) throw new Error(message);
        return { RechargeStatus: 'DONE' };
      });

      const resultPromise = service.waitForRechargeResult({
        rechargeOrderId: ORDER_ID,
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(resultPromise).resolves.toMatchObject({ RechargeStatus: 'DONE' });
      expect(
        actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult'),
      ).toHaveLength(2);
      expect(actionsOf(callFlatApi)).not.toContain('GetRechargeUrl');
    },
  );

  it('stops immediately for a missing order in wait mode without sleeping or retrying', async () => {
    vi.useFakeTimers();
    const upstream = gatewayError('The request processing has failed due to some unknown error.');
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      throw upstream;
    });

    const resultPromise = service.waitForRechargeResult({
      rechargeOrderId: ORDER_ID,
      signal: new AbortController().signal,
    });
    await expect(resultPromise).rejects.toBeInstanceOf(RechargeOrderNotFoundError);
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult')).toHaveLength(
      1,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns timed_out at the configured global deadline during continuous WAIT without another query', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      return { RechargeStatus: 'WAIT' };
    });

    const resultPromise = service.waitForRechargeResult({
      rechargeOrderId: ORDER_ID,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(RECHARGE_POLL_TIMEOUT_MS);

    await expect(resultPromise).resolves.toEqual({
      type: 'recharge',
      rechargeOrderId: ORDER_ID,
      RechargeStatus: 'UNKNOWN',
      reason: 'timed_out',
    });
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult')).toHaveLength(
      RECHARGE_POLL_TIMEOUT_MS / 5_000,
    );
  });

  it('returns timed_out without querying the order when identity loading crosses the global deadline', async () => {
    vi.useFakeTimers();
    let resolveIdentity: (value: unknown) => void = () => {};
    const identity = new Promise<unknown>((resolve) => {
      resolveIdentity = resolve;
    });
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identity;
      throw new Error('GetRechargeResult must not be called');
    });

    const resultPromise = service.waitForRechargeResult({
      rechargeOrderId: ORDER_ID,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(RECHARGE_POLL_TIMEOUT_MS);
    resolveIdentity(identityResponse());

    await expect(resultPromise).resolves.toEqual({
      type: 'recharge',
      rechargeOrderId: ORDER_ID,
      RechargeStatus: 'UNKNOWN',
      reason: 'timed_out',
    });
    expect(actionsOf(callFlatApi)).toEqual(['LoadHumanInfo']);
  });

  it('does not let a late DONE override timed_out when an in-flight query ignores cancellation past the global deadline', async () => {
    vi.useFakeTimers();
    let resolveQuery: (value: unknown) => void = () => {};
    const query = new Promise<unknown>((resolve) => {
      resolveQuery = resolve;
    });
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      return query;
    });

    const resultPromise = service.waitForRechargeResult({
      rechargeOrderId: ORDER_ID,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(actionsOf(callFlatApi)).toContain('GetRechargeResult');
    await vi.advanceTimersByTimeAsync(RECHARGE_POLL_TIMEOUT_MS);
    resolveQuery({ RechargeStatus: 'DONE' });

    await expect(resultPromise).resolves.toMatchObject({
      RechargeStatus: 'UNKNOWN',
      reason: 'timed_out',
    });
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult')).toHaveLength(
      1,
    );
  });

  it('returns interrupted without another query when aborted during sleep', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      return { RechargeStatus: 'WAIT' };
    });

    const resultPromise = service.waitForRechargeResult({
      rechargeOrderId: ORDER_ID,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new DOMException('SIGINT', 'AbortError'));
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({
      RechargeStatus: 'UNKNOWN',
      reason: 'interrupted',
    });
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult')).toHaveLength(
      1,
    );
  });

  it('does not let a late DONE from an in-flight query override interrupted after SIGINT', async () => {
    let resolveQuery: (value: unknown) => void = () => {};
    const query = new Promise<unknown>((resolve) => {
      resolveQuery = resolve;
    });
    const controller = new AbortController();
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      return query;
    });

    const resultPromise = service.waitForRechargeResult({
      rechargeOrderId: ORDER_ID,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(actionsOf(callFlatApi)).toContain('GetRechargeResult');
    });
    controller.abort(new DOMException('SIGINT', 'AbortError'));
    resolveQuery({ RechargeStatus: 'DONE' });

    await expect(resultPromise).resolves.toMatchObject({
      RechargeStatus: 'UNKNOWN',
      reason: 'interrupted',
    });
    expect(actionsOf(callFlatApi).filter((action) => action === 'GetRechargeResult')).toHaveLength(
      1,
    );
  });
});

describe('BillingService recharge history', () => {
  it('sends complete query parameters and normalizes public history fields', async () => {
    const startTime = Date.parse('2026-08-22T00:00:00.000+08:00');
    const endTime = Date.parse('2026-08-24T23:59:59.999+08:00');
    const { service, callFlatApi } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      return {
        TotalCount: 1,
        Data: [
          {
            TradeTime: '2026-08-24T02:00Z',
            TradeTimeStr: '2026-08-24 10:00:27',
            TradeType: 'CHARGE',
            TradeChannel: 'ALIPAY',
            DealAmount: '1.2',
            Currency: 'CNY',
            InternalTransactionId: 'must-not-leak',
          },
        ],
      };
    });

    await expect(
      service.getRechargeHistory({ startTime, endTime, page: 2, pageSize: 5 }),
    ).resolves.toEqual({
      startTime: '2026-08-22T00:00:00.000+08:00',
      endTime: '2026-08-24T23:59:59.999+08:00',
      page: 2,
      pageSize: 5,
      totalCount: 1,
      records: [
        {
          tradeTime: '2026-08-24 10:00:27',
          tradeType: 'CHARGE',
          tradeChannel: 'ALIPAY',
          amount: '1.20',
          currency: 'CNY',
        },
      ],
    });
    expect(callFlatApi.mock.calls[1]?.[0]).toEqual({
      product: 'BssOpenAPI-V3',
      action: 'GetFundFlow',
      params: {
        CurrentPage: 2,
        PageSize: 5,
        StartTime: startTime,
        EndTime: endTime,
        TradeTypeList: ['CHARGE'],
        Nbid: NBID,
      },
    });
  });

  it.each([
    [{ TotalCount: 0, Data: null }, 'Data'],
    [{ TotalCount: -1, Data: [] }, 'TotalCount'],
    [{ TotalCount: 1.5, Data: [] }, 'TotalCount'],
    [
      {
        TotalCount: 1,
        Data: [
          {
            TradeTimeStr: '2026-08-24 10:00:27',
            TradeType: 'REFUND',
            TradeChannel: 'ALIPAY',
            DealAmount: '1.00',
            Currency: 'CNY',
          },
        ],
      },
      'trade type',
    ],
    [
      {
        TotalCount: 1,
        Data: [
          {
            TradeTimeStr: '2026-08-24 10:00:27',
            TradeType: 'CHARGE',
            TradeChannel: 'ALIPAY',
            DealAmount: '1.234',
            Currency: 'CNY',
          },
        ],
      },
      'amount',
    ],
  ])('fails immediately for malformed GetFundFlow response: %s', async (response, message) => {
    const { service } = createService(async (options) => {
      if (options.action === 'LoadHumanInfo') return identityResponse();
      return response;
    });

    await expect(service.getRechargeHistory({ startTime: 1, endTime: 2 })).rejects.toThrow(message);
  });
});

describe('isTransientRechargeGatewayFailure', () => {
  it.each(['408', '429', '500', '503'])('recognizes transient gateway status code %s', (code) => {
    expect(isTransientRechargeGatewayFailure(gatewayError('gateway error', code))).toBe(true);
  });

  it('does not treat ordinary or explicitly non-transient gateway errors as retryable', () => {
    expect(isTransientRechargeGatewayFailure(new Error('temporarily unavailable'))).toBe(false);
    expect(isTransientRechargeGatewayFailure(gatewayError('bad request', '400'))).toBe(false);
  });
});
