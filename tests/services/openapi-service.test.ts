import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockApiClient } from '../helpers/service-mocks.js';
import { apiPolicyFixtureRules } from '../fixtures/api-policy-plugin.js';
import type { OpenApiPolicyRule } from '../../src/config/openapi-policy.js';

const policyState = vi.hoisted(() => ({ rules: [] as OpenApiPolicyRule[] }));
vi.mock('../../src/config/openapi-policy.js', () => ({
  getConfiguredOpenApiRules: () => policyState.rules,
  findConfiguredOpenApiPolicy: (product: string, action: string) =>
    policyState.rules.find((rule) => rule.product === product && rule.actions.includes(action)),
}));

const { ensureAuthenticated, resolveCredentials, getCredentials } = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn(() => ({ access_token: 'synthetic-openapi-credential' })),
  resolveCredentials: vi.fn<() => { access_token: string } | null>(() => ({
    access_token: 'synthetic-openapi-credential',
  })),
  getCredentials: vi.fn(() => ({ access_token: 'synthetic-openapi-credential' })),
}));

vi.mock('../../src/auth/credentials.js', () => ({
  ensureAuthenticated,
  resolveCredentials,
  getCredentials,
}));
vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));

import { OpenApiService } from '../../src/services/openapi-service.js';
import { authRequiredError, CliError } from '../../src/utils/errors.js';

const existingCapabilities = [
  ['AliyunDeliveryService', 'ListModelSeries'],
  ['BssOpenAPI-V3', 'DescribeFqInstance'],
  ['BssOpenAPI-V3', 'DescribeFrInstances'],
  ['BssOpenAPI-V3', 'MaasListConsumeSummary'],
  ['BssOpenAPI-V3', 'GetFundAccountAvailableAmount'],
  ['WebsitePortal', 'SearchHub'],
] as const;

const backendCapabilities = [
  ['WebsitePortal', 'ListModelSeries'],
  ['AliyunDeliveryService', 'SearchHub'],
  ['BssOpenAPI-V3', 'SearchHub'],
  ['FutureProduct', 'FutureWriteAction'],
  ['WebsitePortal', 'GetHubSkill'],
  ['aliyun-search-maas', 'SearchAll'],
  ['AccountCenter', 'QueryAccountInfoOverview'],
  ['BssOpenAPI-V3', 'CreateOrder'],
  ['BssOpenAPI-V3', 'GetRechargeResult'],
  ['sfm_bailian', 'BroadScopeAspnGateway'],
  ['sfm_bailian', 'ListModelSeries'],
  ['BssOpenAPI-V3', 'BroadScopeAspnGateway'],
  ['Workorder', 'ListTickets'],
  ['Workorder', 'CreateTicketNew'],
  ['aliyundeliveryservice', 'ListModelSeries'],
  ['AliyunDeliveryService', 'listmodelseries'],
  ['AliyunDeliveryService ', 'ListModelSeries'],
  ['AliyunDeliveryService', ' ListModelSeries'],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  policyState.rules = apiPolicyFixtureRules();
});

describe('OpenApiService.call', () => {
  it('without installed-plugin policy, SearchHub requires authentication before the client call', async () => {
    policyState.rules = [];
    resolveCredentials.mockReturnValueOnce(null);
    ensureAuthenticated.mockImplementationOnce(() => {
      throw authRequiredError();
    });
    const api = makeMockApiClient();

    await expect(
      new OpenApiService(api).call({ product: 'WebsitePortal', action: 'SearchHub' }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', exitCode: 2 });

    expect(api.callFlatApi).not.toHaveBeenCalled();
  });

  it('without installed-plugin policy, authenticated SearchHub data remains raw', async () => {
    policyState.rules = [];
    const data = { Success: false, Code: 'BUSINESS_VALUE', Data: { preserved: true } };
    const api = makeMockApiClient({ flat: async () => data });

    await expect(
      new OpenApiService(api).call({ product: 'WebsitePortal', action: 'SearchHub' }),
    ).resolves.toBe(data);

    expect(api.callFlatApi).toHaveBeenCalledOnce();
    expect(api.callFlatApi.mock.calls[0]?.[0].authOptional).toBe(false);
  });

  it.each(existingCapabilities)(
    'allows %s/%s, preserves business data, and calls Type A exactly once',
    async (product, action) => {
      const data = { success: false, code: 'BusinessValue', data: { total: 2 }, page: 1 };
      const api = makeMockApiClient({
        flat: async () => (action === 'SearchHub' ? { Success: true, Data: data } : data),
      });
      const signal = new AbortController().signal;
      const params = { Language: 'zh-CN', nested: { list: [1, false] } };
      const out = await new OpenApiService(api).call({ product, action, params, signal });
      expect(out).toBe(data);
      expect(api.callFlatApi).toHaveBeenCalledExactlyOnceWith({
        product,
        action,
        params,
        signal,
        authOptional: product === 'WebsitePortal' && action === 'SearchHub',
      });
      expect(api.callEnvelopeApi).not.toHaveBeenCalled();
      expect(api.callOrchestrationApi).not.toHaveBeenCalled();
      expect(api.callCsDataApi).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['AliyunDeliveryService', 'ListModelSeries'],
    ['WebsitePortal', 'SearchHub'],
  ])(
    'passes the single resolved credential into the %s/%s authentication gate',
    async (product, action) => {
      const resolved = { access_token: 'synthetic-resolved-credential' };
      resolveCredentials.mockReturnValueOnce(resolved);
      const api = makeMockApiClient({
        flat: async () => (action === 'SearchHub' ? { Success: true, Data: {} } : {}),
      });
      await new OpenApiService(api).call({ product, action });
      expect(resolveCredentials).toHaveBeenCalledOnce();
      expect(ensureAuthenticated).toHaveBeenCalledExactlyOnceWith(resolved);
      expect(getCredentials).not.toHaveBeenCalled();
    },
  );

  it.each(backendCapabilities)(
    'delegates %s/%s admission to the backend and forwards once without inferring business success',
    async (product, action) => {
      const data = { Success: false, Code: 'BUSINESS_VALUE', Data: { unchanged: true } };
      const api = makeMockApiClient({ flat: async () => data });
      const params = { unchanged: ['中文', 0, false, null] };
      const signal = new AbortController().signal;
      await expect(new OpenApiService(api).call({ product, action, params, signal })).resolves.toBe(
        data,
      );
      expect(api.callFlatApi).toHaveBeenCalledExactlyOnceWith({
        product,
        action,
        params,
        signal,
        authOptional:
          (product === 'WebsitePortal' && action === 'GetHubSkill') ||
          (product === 'aliyun-search-maas' && action === 'SearchAll'),
      });
      expect(api.callEnvelopeApi).not.toHaveBeenCalled();
      expect(api.callOrchestrationApi).not.toHaveBeenCalled();
      expect(api.callCsDataApi).not.toHaveBeenCalled();
    },
  );

  it.each([
    { product: undefined },
    { product: '' },
    { product: ' \t ' },
    { product: null },
    { product: 42 },
    { action: undefined },
    { action: '' },
    { action: '\n ' },
    { action: null },
    { action: false },
    { params: null },
    { params: [] },
    { params: 'private-invalid-params' },
    { params: 42 },
    { params: true },
  ])('rejects invalid input %j with INVALID_ARGUMENT/4 and no client calls', async (invalid) => {
    const api = makeMockApiClient();
    const options = { product: 'CustomProduct', action: 'CustomAction', ...invalid };
    await expect(
      new OpenApiService(api).call(options as unknown as Parameters<OpenApiService['call']>[0]),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', exitCode: 4 });
    expect(api.callFlatApi).not.toHaveBeenCalled();
    expect(api.callEnvelopeApi).not.toHaveBeenCalled();
    expect(api.callOrchestrationApi).not.toHaveBeenCalled();
    expect(api.callCsDataApi).not.toHaveBeenCalled();
  });

  it('forwards routing and authentication names in params only as business fields', async () => {
    const api = makeMockApiClient({ flat: async () => ({}) });
    const params = {
      product: 'sfm_bailian',
      action: 'BroadScopeAspnGateway',
      region: 'other-region',
      authOptional: true,
      authMode: 'none',
      url: 'https://override.test.qianwenai.com',
      headers: { 'X-Test': 'business-field' },
    };
    await new OpenApiService(api).call({
      product: 'AliyunDeliveryService',
      action: 'ListModelSeries',
      params,
    });
    expect(api.callFlatApi.mock.calls[0]?.[0]).toMatchObject({
      product: 'AliyunDeliveryService',
      action: 'ListModelSeries',
      params,
    });
    expect(api.callFlatApi.mock.calls[0]?.[0]).toHaveProperty('authOptional', false);
    expect(api.callFlatApi.mock.calls[0]?.[0]).not.toHaveProperty('url');
    expect(api.callFlatApi.mock.calls[0]?.[0]).not.toHaveProperty('headers');
  });

  it.each([
    { code: 'NETWORK_ERROR', message: 'offline', exitCode: 3 },
    { code: 'SERVER_ERROR', message: 'backend denied this operation', exitCode: 6 },
  ] as const)('preserves $code error identity and exit code without retrying', async (details) => {
    const error = new CliError(details);
    const api = makeMockApiClient({
      flat: async () => {
        throw error;
      },
    });
    await expect(
      new OpenApiService(api).call({
        product: 'FutureProduct',
        action: 'FutureWriteAction',
      }),
    ).rejects.toBe(error);
    expect(api.callFlatApi).toHaveBeenCalledOnce();
  });
});

describe('OpenApiService SearchHub envelope contract', () => {
  const hub = { product: 'WebsitePortal', action: 'SearchHub' };
  const payloads = [
    null,
    [],
    {},
    false,
    0,
    '',
    '中文',
    { success: false, code: 'BUSINESS_VALUE', data: { amount: '001.20' } },
  ];

  it.each([
    { Success: null, success: true, Code: 'DENIED' },
    { Success: false, Code: null, code: '200' },
    { Success: true, success: 'invalid-shadowed-value', Code: '200', code: {} },
  ])('uses nullish PascalCase status precedence for $Success/$Code', async (status) => {
    const payload = { preserved: true };
    const api = makeMockApiClient({ flat: async () => ({ ...status, Data: payload }) });
    await expect(new OpenApiService(api).call(hub)).resolves.toBe(payload);
  });

  it('does not replace an explicit PascalCase null payload with lowercase data', async () => {
    const api = makeMockApiClient({
      flat: async () => ({ Success: true, Data: null, data: { fallback: true } }),
    });
    await expect(new OpenApiService(api).call(hub)).resolves.toBeNull();
  });

  it('falls back from undefined PascalCase Data while preserving lowercase identity', async () => {
    const payload = { fallback: true };
    const api = makeMockApiClient({
      flat: async () => ({ Success: true, Data: undefined, data: payload }),
    });
    await expect(new OpenApiService(api).call(hub)).resolves.toBe(payload);
  });

  it.each([
    { Message: 'PascalCase failure', message: 'lowercase failure', expected: 'PascalCase failure' },
    { Message: null, message: 'lowercase failure', expected: 'lowercase failure' },
    { Message: '', message: 'lowercase failure', expected: '' },
  ])('keeps failed PascalCase status and nullish message precedence: $expected', async (fields) => {
    const api = makeMockApiClient({
      flat: async () => ({
        Success: false,
        success: true,
        Code: 'NOT_FOUND',
        code: '200',
        Message: fields.Message,
        message: fields.message,
        Data: {},
      }),
    });
    await expect(new OpenApiService(api).call(hub)).rejects.toMatchObject({
      name: 'GatewayBusinessError',
      code: 'NOT_FOUND',
      message: fields.expected,
    });
  });

  it.each([
    { Success: 'true', Code: 200 },
    { Success: 1, Code: '200' },
    { Success: true, Code: false },
    { Success: true, Code: {} },
    { success: 'false', code: 200 },
    { success: true, code: [200] },
  ])(
    'rejects invalid selected status types even if the other status succeeds: %j',
    async (status) => {
      const api = makeMockApiClient({ flat: async () => ({ ...status, Data: {} }) });
      await expect(new OpenApiService(api).call(hub)).rejects.toMatchObject({
        code: 'API_RESPONSE_INVALID',
        exitCode: 6,
      });
    },
  );

  it.each(payloads.map((payload) => ({ payload })))(
    'preserves the explicit payload $payload in both envelope casings',
    async ({ payload }) => {
      for (const envelope of [
        { Success: true, Data: payload, data: { unwantedFallback: true } },
        { success: true, data: payload },
      ]) {
        const api = makeMockApiClient({ flat: async () => envelope });
        await expect(new OpenApiService(api).call(hub)).resolves.toBe(payload);
        expect(api.callFlatApi).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { Success: true, Code: 'NOT_FOUND' },
    { Success: false, Code: '200' },
    { Code: 200 },
    { success: true, code: 'NOT_FOUND' },
    { success: false, code: 200 },
  ])(
    'accepts the documented OR success predicate in $Success/$Code/$success/$code',
    async (status) => {
      const payload = { unchanged: false };
      const api = makeMockApiClient({ flat: async () => ({ ...status, Data: payload }) });
      await expect(new OpenApiService(api).call(hub)).resolves.toBe(payload);
    },
  );

  it.each([
    { Success: false, Code: 'NOT_FOUND', Message: 'synthetic Hub failure', Data: { records: [] } },
    { success: false, code: 'NOT_FOUND', message: 'synthetic Hub failure' },
  ])('rejects a known failed Hub envelope even when data is present', async (envelope) => {
    const api = makeMockApiClient({ flat: async () => envelope });
    await expect(new OpenApiService(api).call(hub)).rejects.toMatchObject({
      name: 'GatewayBusinessError',
      code: 'NOT_FOUND',
      message: 'synthetic Hub failure',
    });
    expect(api.callFlatApi).toHaveBeenCalledOnce();
  });

  it.each([
    { envelope: undefined },
    { envelope: null },
    { envelope: [] },
    { envelope: 'invalid' },
    { envelope: 0 },
    { envelope: {} },
    { envelope: { Data: {} } },
    { envelope: { Success: true } },
    { envelope: { code: 200 } },
    { envelope: { Success: true, Data: undefined } },
  ])(
    'rejects malformed or missing Hub output $envelope as API_RESPONSE_INVALID/6',
    async ({ envelope }) => {
      const api = makeMockApiClient({ flat: async () => envelope });
      await expect(new OpenApiService(api).call(hub)).rejects.toMatchObject({
        code: 'API_RESPONSE_INVALID',
        exitCode: 6,
      });
      expect(api.callFlatApi).toHaveBeenCalledOnce();
    },
  );
});
