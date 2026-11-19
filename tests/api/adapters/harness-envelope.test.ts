import { describe, expect, it, vi } from 'vitest';
import {
  buildEnvelopePayload,
  buildFlatEnvelopePayload,
  unwrapFlatEnvelopeResponse,
} from '../../../src/api/adapters/gateway-adapter.js';
import { createApiClient } from '../../../src/api/api-client.js';
import { createTokenPlanBenefitsReader } from '../../../src/services/tokenplan-benefits.js';
import type { BaseClient, RequestOptions } from '../../../src/api/base-client.js';
import {
  API_TOKENPLAN_TOOL_CATALOG,
  API_TOKENPLAN_TOOL_EQUITY,
} from '../../../src/types/api-routes.js';

const requestId = '11111111-2222-3333-4444-555555555555';
function catalogResponse(items: unknown[] = []) {
  return {
    code: '200',
    successResponse: true,
    data: {
      DataV2: {
        api: API_TOKENPLAN_TOOL_CATALOG,
        ret: ['SUCCESS::ok'],
        data: { success: true, data: { items } },
      },
    },
  };
}

function legacyCatalogResponse(): unknown {
  return {
    code: '200',
    successResponse: true,
    data: {
      Data: JSON.stringify({ api: API_TOKENPLAN_TOOL_CATALOG, data: { data: { items: [] } } }),
    },
  };
}

describe('flat Harness envelopes', () => {
  it('keeps the old reqDTO builder and separately builds flat Data with six default fields', () => {
    expect(
      buildEnvelopePayload({
        api: API_TOKENPLAN_TOOL_EQUITY,
        data: { queryTokenPlanEquityInfoRequest: { requestId } },
      }).data,
    ).toHaveProperty('reqDTO');
    const flat = buildFlatEnvelopePayload({
      api: API_TOKENPLAN_TOOL_EQUITY,
      data: { queryTokenPlanEquityInfoRequest: { requestId } },
    });
    expect(flat.data).not.toHaveProperty('reqDTO');
    expect(flat.data.queryTokenPlanEquityInfoRequest).toEqual({ requestId });
    expect(Object.keys(flat.cornerstoneParam).sort()).toEqual([
      'console',
      'consoleSite',
      'domain',
      'productCode',
      'protocol',
      'xsp_lang',
    ]);
    const overridden = buildFlatEnvelopePayload({
      api: API_TOKENPLAN_TOOL_CATALOG,
      data: {},
      cornerstoneParam: { domain: 'gateway.test.qianwenai.com', mainAccountUid: 'test-account' },
      switchAgent: 42,
    });
    expect(overridden.cornerstoneParam).toMatchObject({
      domain: 'gateway.test.qianwenai.com',
      consoleSite: 'QIANWENAI',
      console: 'ONE_CONSOLE',
      xsp_lang: 'zh-CN',
      protocol: 'V2',
      productCode: 'p_efm',
      mainAccountUid: 'test-account',
      switchAgent: 42,
    });
    expect(overridden.data.cornerstoneParam).toEqual(overridden.cornerstoneParam);
  });

  it('rejects unregistered flat APIs and malformed equity/catalog parameters', () => {
    expect(() => buildFlatEnvelopePayload({ api: 'unregistered.api', data: {} })).toThrow();
    expect(() =>
      buildFlatEnvelopePayload({ api: API_TOKENPLAN_TOOL_EQUITY, data: { reqDTO: { requestId } } }),
    ).toThrow();
    expect(() =>
      buildFlatEnvelopePayload({
        api: API_TOKENPLAN_TOOL_EQUITY,
        data: { queryTokenPlanEquityInfoRequest: { requestId: 'not-a-uuid' } },
      }),
    ).toThrow();
    expect(() =>
      buildFlatEnvelopePayload({
        api: API_TOKENPLAN_TOOL_CATALOG,
        data: { mainAccountUid: 'unverified' },
      }),
    ).toThrow();
  });

  it('keeps the legacy catalog JSON-string variant and validates all success layers', () => {
    expect(unwrapFlatEnvelopeResponse(legacyCatalogResponse(), API_TOKENPLAN_TOOL_CATALOG)).toEqual(
      {
        items: [],
      },
    );
    expect(() =>
      unwrapFlatEnvelopeResponse(
        { code: '200', successResponse: true, data: { Data: '{}' } },
        API_TOKENPLAN_TOOL_CATALOG,
      ),
    ).toThrow();
    expect(() =>
      unwrapFlatEnvelopeResponse(
        {
          code: '200',
          successResponse: true,
          data: {
            errorCode: 'BUSINESS_FAILURE',
            Data: JSON.stringify({ data: { data: { items: [] } } }),
          },
        },
        API_TOKENPLAN_TOOL_CATALOG,
      ),
    ).toThrow();
    expect(() =>
      unwrapFlatEnvelopeResponse(
        { code: '200', successResponse: true, data: { Data: 'invalid' } },
        API_TOKENPLAN_TOOL_CATALOG,
      ),
    ).toThrow();
    expect(() =>
      unwrapFlatEnvelopeResponse(
        { code: '200', successResponse: false, data: {} },
        API_TOKENPLAN_TOOL_CATALOG,
      ),
    ).toThrow();
    expect(() =>
      unwrapFlatEnvelopeResponse(
        {
          code: '200',
          successResponse: true,
          data: { Data: JSON.stringify({ data: { success: false, data: { items: [] } } }) },
        },
        API_TOKENPLAN_TOOL_CATALOG,
      ),
    ).toThrow();
  });

  it.each([
    { items: [] },
    { items: [{ type: 'fixture-tool', title: 'Fixture Harness', hasResourcePack: true }] },
  ])(
    'decodes the observed DataV2 catalog shape including an empty items array: $items',
    ({ items }) => {
      expect(
        unwrapFlatEnvelopeResponse(catalogResponse(items), API_TOKENPLAN_TOOL_CATALOG),
      ).toEqual({
        items,
      });
    },
  );

  it.each([
    ['missing ret', { data: { success: true, data: { items: [] } } }],
    ['empty ret', { ret: [], data: { success: true, data: { items: [] } } }],
    ['failed ret', { ret: ['FAIL::error'], data: { success: true, data: { items: [] } } }],
    ['failed business', { ret: ['SUCCESS::ok'], data: { success: false, data: { items: [] } } }],
    [
      'failed business code',
      { ret: ['SUCCESS::ok'], data: { code: 'FAILED', data: { items: [] } } },
    ],
    ['missing payload', { ret: ['SUCCESS::ok'], data: { success: true } }],
    ['missing items', { ret: ['SUCCESS::ok'], data: { success: true, data: {} } }],
    ['null items', { ret: ['SUCCESS::ok'], data: { success: true, data: { items: null } } }],
    ['object items', { ret: ['SUCCESS::ok'], data: { success: true, data: { items: {} } } }],
    [
      'unexpected nesting',
      { ret: ['SUCCESS::ok'], data: { success: true, data: { data: { items: [] } } } },
    ],
    [
      'API mismatch',
      {
        api: API_TOKENPLAN_TOOL_EQUITY,
        ret: ['SUCCESS::ok'],
        data: { success: true, data: { items: [] } },
      },
    ],
  ])('rejects a malformed DataV2 catalog without falling back to legacy Data: %s', (_, dataV2) => {
    expect(() =>
      unwrapFlatEnvelopeResponse(
        {
          code: '200',
          successResponse: true,
          data: {
            DataV2: dataV2,
            Data: JSON.stringify({ data: { data: { items: [] } } }),
          },
        },
        API_TOKENPLAN_TOOL_CATALOG,
      ),
    ).toThrow();
  });

  it('rejects a DataV2 catalog when either outer success layer fails', () => {
    const response = catalogResponse();
    response.successResponse = false;
    expect(() => unwrapFlatEnvelopeResponse(response, API_TOKENPLAN_TOOL_CATALOG)).toThrow();
    response.successResponse = true;
    expect(() =>
      unwrapFlatEnvelopeResponse(
        { ...response, data: { ...response.data, success: false } },
        API_TOKENPLAN_TOOL_CATALOG,
      ),
    ).toThrow();
  });

  it('reads catalog and granted benefits through DataV2 while sharing one catalog request', async () => {
    const calls: RequestOptions[] = [];
    const base: BaseClient = {
      request: vi.fn(async <T>(options: RequestOptions): Promise<T> => {
        calls.push(options);
        const request = JSON.parse(options.body ?? '{}');
        if (request.params.Api === API_TOKENPLAN_TOOL_CATALOG) {
          return catalogResponse([
            {
              type: 'fixture-tool',
              title: 'Fixture Harness',
              hasResourcePack: true,
              planCodes: ['fixture-pack'],
              quotaUnit: 'Credits',
            },
            { type: 'without-pack', title: 'Other Tool', hasResourcePack: false },
          ]) as T;
        }
        expect(request.params.Api).toBe(API_TOKENPLAN_TOOL_EQUITY);
        return {
          code: '200',
          successResponse: true,
          data: {
            DataV2: {
              ret: ['SUCCESS::ok'],
              data: {
                success: true,
                data: {
                  tokenPlanEquityInfos: [
                    { equityType: 'fixture-pack', totalQuota: 100, availableQuota: 0 },
                  ],
                },
              },
            },
          },
        } as T;
      }),
    };
    const reader = createTokenPlanBenefitsReader(createApiClient({ baseClient: base }));
    const [catalog, allowances] = await Promise.all([
      reader.loadHarnessCatalog(),
      reader.loadHarnessAllowances(),
    ]);
    expect(catalog).toEqual([
      {
        toolId: 'fixture-tool',
        toolName: 'Fixture Harness',
        freeQuota: null,
        quotaUnit: 'Credits',
        discount: null,
        discountType: null,
      },
    ]);
    expect(allowances).toEqual([
      {
        toolId: 'fixture-tool',
        toolName: 'Fixture Harness',
        totalQuota: '100',
        remainingQuota: '0',
        quotaUnit: 'Credits',
        startAt: null,
        endAt: null,
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.authMode === 'required')).toBe(true);
  });

  it('requires a successful ret and rejects equity business failure', () => {
    const response = {
      code: '200',
      successResponse: true,
      data: {
        DataV2: {
          ret: ['SUCCESS::ok'],
          data: { success: true, data: { tokenPlanEquityInfos: [] } },
        },
      },
    };
    expect(unwrapFlatEnvelopeResponse(response, API_TOKENPLAN_TOOL_EQUITY)).toEqual({
      tokenPlanEquityInfos: [],
    });
    response.data.DataV2.ret = ['FAIL::error'];
    expect(() => unwrapFlatEnvelopeResponse(response, API_TOKENPLAN_TOOL_EQUITY)).toThrow();
    response.data.DataV2.ret = ['SUCCESS::ok'];
    response.data.DataV2.data.success = false;
    expect(() => unwrapFlatEnvelopeResponse(response, API_TOKENPLAN_TOOL_EQUITY)).toThrow();
  });

  it('routes flat mode through the existing authenticated transport and forwards cancellation', async () => {
    const calls: RequestOptions[] = [];
    const base: BaseClient = {
      request: vi.fn(async <T>(options: RequestOptions): Promise<T> => {
        calls.push(options);
        return catalogResponse() as T;
      }),
    };
    const client = createApiClient({ baseClient: base });
    const controller = new AbortController();
    expect(
      await client.callEnvelopeApi({
        api: API_TOKENPLAN_TOOL_CATALOG,
        dataMode: 'flat',
        data: {},
        signal: controller.signal,
      }),
    ).toEqual({ items: [] });
    expect(calls[0]?.authMode).toBe('required');
    expect(calls[0]?.signal).toBe(controller.signal);
    const request = JSON.parse(calls[0]?.body ?? '{}');
    const data = JSON.parse(request.params.Data);
    expect(request.product).toBe('sfm_bailian');
    expect(request.action).toBe('BroadScopeAspnGateway');
    expect(data).not.toHaveProperty('reqDTO');
    expect(data.cornerstoneParam).toMatchObject({ consoleSite: 'QIANWENAI' });
    await expect(
      client.callEnvelopeApi({ api: 'unregistered.api', dataMode: 'flat', data: {} }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
