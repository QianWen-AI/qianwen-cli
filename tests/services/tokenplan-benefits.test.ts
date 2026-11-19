import { describe, expect, it, vi } from 'vitest';
import type {
  ApiClient,
  CallCsDataApiOptions,
  CallEnvelopeApiOptions,
} from '../../src/api/api-client.js';
import {
  createTokenPlanBenefitsReader,
  fetchTokenPlanHarnessAllowances,
  fetchTokenPlanHarnessCatalog,
  fetchTokenPlanSupportedModels,
} from '../../src/services/tokenplan-benefits.js';
import {
  API_TOKENPLAN_MODEL_PROVIDERS,
  API_TOKENPLAN_SUPPORTED_MODELS,
  API_TOKENPLAN_TOOL_CATALOG,
  API_TOKENPLAN_TOOL_EQUITY,
} from '../../src/types/api-routes.js';
import type { TokenPlanSupportedModel } from '../../src/types/tokenplan-benefits.js';

function mockClient(
  options: {
    models?: (pageNo: number, edition: unknown) => unknown;
    providers?: unknown;
    providerError?: Error;
    catalog?: unknown;
    catalogError?: Error;
    equity?: unknown;
    equityError?: Error;
  } = {},
): { client: ApiClient; requests: Array<CallCsDataApiOptions<unknown> | CallEnvelopeApiOptions> } {
  const requests: Array<CallCsDataApiOptions<unknown> | CallEnvelopeApiOptions> = [];
  const client: ApiClient = {
    callFlatApi: vi.fn(),
    callOrchestrationApi: vi.fn(),
    callCsDataApi: async <T>(input: CallCsDataApiOptions<T>): Promise<T> => {
      requests.push(input);
      if (input.api === API_TOKENPLAN_MODEL_PROVIDERS) {
        if (options.providerError) throw options.providerError;
        return input.parse({
          data: options.providers ?? [
            {
              providerId: 'group',
              displayName: 'Group',
              items: [
                { providerId: 'brand-b', displayName: 'Brand B' },
                { providerId: 'brand-a', displayName: 'Brand A' },
              ],
            },
          ],
        });
      }
      if (input.api !== API_TOKENPLAN_SUPPORTED_MODELS) throw new Error('unexpected cs-data API');
      const query = input.data?.input as { pageNo: number; edition: unknown };
      return input.parse({
        data: options.models?.(query.pageNo, query.edition) ?? {
          total: 0,
          pageNo: query.pageNo,
          pageSize: 100,
          list: [],
        },
      });
    },
    callEnvelopeApi: async <T>(input: CallEnvelopeApiOptions): Promise<T> => {
      requests.push(input);
      if (input.api === API_TOKENPLAN_TOOL_CATALOG) {
        if (options.catalogError) throw options.catalogError;
        return (options.catalog ?? { items: [] }) as T;
      }
      if (input.api !== API_TOKENPLAN_TOOL_EQUITY) throw new Error('unexpected envelope API');
      if (options.equityError) throw options.equityError;
      return (options.equity ?? { tokenPlanEquityInfos: [] }) as T;
    },
  };
  return { client, requests };
}

function model(id: string, provider = 'brand-a'): unknown {
  return {
    modelId: id,
    provider,
    name: JSON.stringify({ 'zh-CN': `名称 ${id}`, 'en-US': `Name ${id}` }),
    capabilities: ['VU', 'TG', 'TG', 'custom'],
    internalCredential: 'must-not-project',
  };
}

describe('Token Plan supported model reader', () => {
  it.each(['individual', 'team'] as const)(
    'preserves public badge metadata and optional-field omission for %s models',
    async (edition) => {
      const cases: Array<{
        id: string;
        input: Record<string, unknown>;
        expected: Partial<TokenPlanSupportedModel>;
      }> = [
        {
          id: 'promotion-new',
          input: { isNew: true, badgeLabel: '限时2折', badgeDescription: 'Credits消耗限时2折' },
          expected: { isNew: true, badgeLabel: '限时2折', badgeDescription: 'Credits消耗限时2折' },
        },
        {
          id: 'promotion',
          input: { isNew: false, badgeLabel: '限时5折' },
          expected: { isNew: false, badgeLabel: '限时5折' },
        },
        { id: 'new', input: { isNew: true }, expected: { isNew: true } },
        { id: 'legacy', input: {}, expected: {} },
        {
          id: 'empty',
          input: { isNew: false, badgeLabel: '', badgeDescription: '' },
          expected: { isNew: false, badgeLabel: '', badgeDescription: '' },
        },
        {
          id: 'invalid',
          input: { isNew: 'true', badgeLabel: 2, badgeDescription: {} },
          expected: {},
        },
      ];
      const { client } = mockClient({
        models: (pageNo) => ({
          total: cases.length,
          pageNo,
          pageSize: 100,
          list: cases.map(({ id, input }) => ({
            modelId: id,
            provider: 'brand-a',
            name: JSON.stringify({ 'zh-CN': '模型显示名' }),
            capabilities: [],
            ...input,
          })),
        }),
      });
      const models = await createTokenPlanBenefitsReader(client).loadModels(edition);
      expect(models).toEqual(
        cases.map(({ id, expected }) => ({
          modelId: id,
          modelBrand: 'Brand A',
          modelName: '模型显示名',
          capabilities: [],
          ...expected,
        })),
      );
    },
  );

  it('shares the provider tree across editions, keeps brand and in-brand order, and projects only public fields', async () => {
    const { client, requests } = mockClient({
      models: (pageNo) => ({
        total: 3,
        pageNo,
        pageSize: 100,
        list: [model('a1'), model('b1', 'brand-b'), model('a2')],
      }),
    });
    const reader = createTokenPlanBenefitsReader(client);
    const [individual, team] = await Promise.all([
      reader.loadModels('individual'),
      reader.loadModels('team'),
    ]);
    expect(individual.map((item) => item.modelId)).toEqual(['b1', 'a1', 'a2']);
    expect(team).toEqual(individual);
    expect(individual[1]).toEqual({
      modelId: 'a1',
      modelBrand: 'Brand A',
      modelName: '名称 a1',
      capabilities: ['TG', 'VU', 'custom'],
    });
    expect(JSON.stringify(individual)).not.toContain('must-not-project');
    expect(requests.filter((input) => input.api === API_TOKENPLAN_MODEL_PROVIDERS)).toHaveLength(1);
    expect(
      requests
        .filter((input) => input.api === API_TOKENPLAN_SUPPORTED_MODELS)
        .map((input) => input.data?.input),
    ).toEqual([
      { pageNo: 1, pageSize: 100, edition: 'PERSONAL' },
      { pageNo: 1, pageSize: 100, edition: 'TEAM' },
    ]);
    await reader.loadModels('individual');
    expect(requests).toHaveLength(3);
  });

  it('reads every page and applies documented name and provider fallbacks', async () => {
    const { client, requests } = mockClient({
      models: (pageNo) => ({
        total: 101,
        pageNo,
        pageSize: 100,
        list:
          pageNo === 1
            ? Array.from({ length: 100 }, (_, index) => model(`m${index}`))
            : [
                {
                  modelId: 'last',
                  provider: 'unknown-brand',
                  name: JSON.stringify({ 'en-US': 'English' }),
                  capabilities: [],
                },
              ],
      }),
    });
    const output = await fetchTokenPlanSupportedModels(client, 'individual');
    expect(output).toHaveLength(101);
    expect(output[100]).toMatchObject({ modelBrand: 'unknown-brand', modelName: 'English' });
    expect(requests.filter((input) => input.api === API_TOKENPLAN_SUPPORTED_MODELS)).toHaveLength(
      2,
    );
    const fallback = mockClient({
      models: (pageNo) => ({
        total: 1,
        pageNo,
        pageSize: 100,
        list: [{ modelId: 'fallback', provider: 'brand-a', name: '{}', capabilities: [] }],
      }),
    });
    expect((await fetchTokenPlanSupportedModels(fallback.client, 'team'))[0]?.modelName).toBe(
      'fallback',
    );
  });

  it.each(['duplicate', 'empty', 'changed-total', 'failed-page'])(
    'rejects incomplete or unstable model paging: %s',
    async (kind) => {
      const { client } = mockClient({
        models: (pageNo) => {
          if (pageNo === 1)
            return {
              total: 101,
              pageNo,
              pageSize: 100,
              list: Array.from({ length: 100 }, (_, index) => model(`m${index}`)),
            };
          if (kind === 'failed-page') throw new Error('page failed');
          return {
            total: kind === 'changed-total' ? 102 : 101,
            pageNo,
            pageSize: 100,
            list: kind === 'empty' ? [] : [model('m0')],
          };
        },
      });
      await expect(fetchTokenPlanSupportedModels(client, 'individual')).rejects.toThrow();
    },
  );

  it('does not invent provider aliases or missing pagination metadata and caches failures once', async () => {
    const invalid = mockClient({
      models: (pageNo) => ({ pageNo, pageSize: 100, list: [model('one')] }),
    });
    await expect(fetchTokenPlanSupportedModels(invalid.client, 'individual')).rejects.toThrow();
    const failure = mockClient({ providerError: new Error('provider failed') });
    const reader = createTokenPlanBenefitsReader(failure.client);
    await expect(reader.loadModels('individual')).rejects.toThrow('provider failed');
    await expect(reader.loadModels('team')).rejects.toThrow('provider failed');
    expect(failure.requests).toHaveLength(1);
    const aliases = mockClient({
      providers: [
        {
          providerId: 'group',
          displayName: 'Group',
          children: [{ providerId: 'brand-a', displayName: 'Alias' }],
        },
      ],
      models: (pageNo) => ({
        total: 1,
        pageNo,
        pageSize: 100,
        list: [{ modelId: 'one', providerId: 'brand-a', name: '{}', capabilities: [] }],
      }),
    });
    await expect(fetchTokenPlanSupportedModels(aliases.client, 'individual')).rejects.toThrow();
  });

  it('checks cancellation before starting model page requests', async () => {
    const { client, requests } = mockClient();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchTokenPlanSupportedModels(client, 'individual', controller.signal),
    ).rejects.toThrow();
    expect(requests.filter((input) => input.api === API_TOKENPLAN_SUPPORTED_MODELS)).toHaveLength(
      0,
    );
  });

  it('rejects an invalid edition before requesting provider or model metadata', async () => {
    const { client, requests } = mockClient();
    const reader = createTokenPlanBenefitsReader(client);
    await expect(reader.loadModels('invalid' as never)).rejects.toThrow(
      'Invalid Token Plan model edition',
    );
    expect(requests).toHaveLength(0);
  });
});

describe('Token Plan Harness reader', () => {
  const catalog = {
    items: [
      {
        title: 'Tool B',
        type: 'tool-b',
        hasResourcePack: true,
        planCodes: ['grant-b'],
        quotaUnit: '次',
        discountQuota: 999,
        priceInfo: { discountedPrice: 5 },
        mcpInfo: { secret: 'not-public' },
      },
      { title: 'Tool A', hasResourcePack: true, planCodes: ['grant-a'], priceInfo: { unit: '张' } },
      { title: 'Not a resource pack', hasResourcePack: false },
    ],
  };
  const equity = {
    tokenPlanEquityInfos: [
      {
        equityType: 'grant-a',
        totalQuota: 100,
        availableQuota: 70,
        instanceStartTime: 0,
        instanceEndTime: 1795708800000,
        private: 'not-public',
      },
      { equityType: 'grant-b', totalQuota: 20, availableQuota: 0 },
      { equityType: 'grant-b', totalQuota: 1000, availableQuota: 999 },
      { equityType: 'unconfigured', totalQuota: '5', availableQuota: '4' },
      { equityType: 'unconfigured', totalQuota: '100', availableQuota: '99' },
    ],
  };

  it('separates catalog quota from actual account grants and shares catalog reads', async () => {
    const { client, requests } = mockClient({ catalog, equity });
    const reader = createTokenPlanBenefitsReader(client);
    const [tools, allowances, benefits] = await Promise.all([
      reader.loadHarnessCatalog(),
      reader.loadHarnessAllowances(),
      reader.loadHarnessBenefits(),
    ]);
    expect(tools[0]).toEqual({
      toolId: 'tool-b',
      toolName: 'Tool B',
      freeQuota: null,
      quotaUnit: '次',
      discount: null,
      discountType: null,
    });
    expect(allowances.map((item) => [item.toolName, item.totalQuota, item.remainingQuota])).toEqual(
      [
        ['Tool B', '20', '0'],
        ['Tool A', '100', '70'],
        ['unconfigured', '5', '4'],
      ],
    );
    expect(allowances[1]?.startAt).toBe('1970-01-01T00:00:00.000Z');
    expect(benefits).toEqual({ allowances, hasResourcePack: true });
    expect(JSON.stringify(tools) + JSON.stringify(allowances)).not.toContain('not-public');
    expect(requests.filter((input) => input.api === API_TOKENPLAN_TOOL_CATALOG)).toHaveLength(1);
    expect(requests.filter((input) => input.api === API_TOKENPLAN_TOOL_EQUITY)).toHaveLength(1);
    expect(requests.every((input) => 'dataMode' in input && input.dataMode === 'flat')).toBe(true);
  });

  it.each([
    ['empty catalog', [], false],
    ['false flag', [{ title: 'Tool', hasResourcePack: false }], false],
    ['missing flag', [{ title: 'Tool' }], false],
    ['string flag', [{ title: 'Tool', hasResourcePack: 'true' }], false],
    ['numeric flag', [{ title: 'Tool', hasResourcePack: 1 }], false],
    ['resource pack without plan codes', [{ title: 'Tool', hasResourcePack: true }], true],
    [
      'unmatched resource pack',
      [
        { title: 'Configured', hasResourcePack: false, planCodes: ['current'] },
        { title: 'Other', hasResourcePack: true, planCodes: ['other'] },
      ],
      true,
    ],
  ])(
    'preserves the frontend catalog flag for %s with successful empty grants',
    async (_name, items, flag) => {
      const { client } = mockClient({ catalog: { items }, equity: { tokenPlanEquityInfos: [] } });
      expect(await createTokenPlanBenefitsReader(client).loadHarnessBenefits()).toEqual({
        allowances: [],
        hasResourcePack: flag,
      });
    },
  );

  it('keeps actual allowances empty and preserves invalid quota as unknown', async () => {
    const noGrants = mockClient({ catalog, equity: { tokenPlanEquityInfos: [] } });
    expect(await fetchTokenPlanHarnessAllowances(noGrants.client)).toEqual([]);
    const empty = mockClient({ equity: { tokenPlanEquityInfos: [] } });
    expect(await fetchTokenPlanHarnessAllowances(empty.client)).toEqual([]);
    const invalid = mockClient({
      catalog,
      equity: {
        tokenPlanEquityInfos: [
          {
            equityType: 'grant-b',
            totalQuota: -1,
            availableQuota: 'unknown',
            instanceEndTime: 'invalid',
          },
        ],
      },
    });
    expect((await fetchTokenPlanHarnessAllowances(invalid.client))[0]).toMatchObject({
      totalQuota: null,
      remainingQuota: null,
      endAt: null,
    });
  });

  it('uses the final frontend display set when non-resource catalog grants are present', async () => {
    const { client } = mockClient({
      catalog: {
        items: [
          { title: 'Configured', hasResourcePack: false, planCodes: ['current'] },
          { title: 'Other', hasResourcePack: true, planCodes: ['other'] },
        ],
      },
      equity: {
        tokenPlanEquityInfos: [{ equityType: 'current', totalQuota: 10, availableQuota: 8 }],
      },
    });
    expect(await createTokenPlanBenefitsReader(client).loadHarnessBenefits()).toEqual({
      allowances: [],
      hasResourcePack: true,
    });
  });

  it('does not convert catalog or grant failures into successful empty arrays', async () => {
    const directory = mockClient({ catalogError: new Error('catalog failed') });
    await expect(fetchTokenPlanHarnessCatalog(directory.client)).rejects.toThrow('catalog failed');
    const grant = mockClient({ catalog, equityError: new Error('equity failed') });
    const reader = createTokenPlanBenefitsReader(grant.client);
    await expect(reader.loadHarnessAllowances()).rejects.toThrow('equity failed');
    await expect(reader.loadHarnessBenefits()).rejects.toThrow('equity failed');
    await expect(reader.loadHarnessAllowances()).rejects.toThrow('equity failed');
    expect(grant.requests.filter((input) => input.api === API_TOKENPLAN_TOOL_EQUITY)).toHaveLength(
      1,
    );
  });

  it('does not classify a catalog failure carrying the former pending code as successful benefits', async () => {
    const error = Object.assign(new Error('catalog failed'), { code: 'TOKENPLAN_HARNESS_PENDING' });
    const { client } = mockClient({ catalogError: error, equity: { tokenPlanEquityInfos: [] } });
    await expect(createTokenPlanBenefitsReader(client).loadHarnessBenefits()).rejects.toBe(error);
  });
});
