import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerPluginCommands, type PluginHandler } from '../../src/plugins/loader.js';
import type { PluginDescriptor } from '../../src/plugins/descriptor.js';
import type { OpenApiPolicyRule } from '../../src/config/openapi-policy.js';
import { isPublicOpenApiOperation } from '../../src/api/openapi-access.js';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ authMode?: string; body?: string; signal?: AbortSignal }>,
  data: {} as unknown,
  failure: undefined as unknown,
  auth: 'valid' as 'valid' | 'expired' | null,
  rules: [] as OpenApiPolicyRule[],
}));
vi.mock('../../src/api/base-client.js', () => ({
  createBaseClient: () => ({
    request: vi.fn(async (options) => {
      state.calls.push(options);
      if (state.failure) throw state.failure;
      return { code: '200', data: state.data };
    }),
  }),
}));
vi.mock('../../src/auth/credentials.js', () => ({
  resolveCredentials: () =>
    state.auth === null ? null : { access_token: 'synthetic-default-credential' },
  getCredentials: () =>
    state.auth === null ? null : { access_token: 'synthetic-default-credential' },
  ensureAuthenticated: () => {
    if (state.auth === null)
      throw Object.assign(new Error('Login required'), { code: 'AUTH_REQUIRED', exitCode: 2 });
    if (state.auth === 'expired')
      throw Object.assign(new Error('Login expired'), { code: 'TOKEN_EXPIRED', exitCode: 2 });
    return { access_token: 'synthetic-default-credential' };
  },
}));
vi.mock('../../src/config/openapi-policy.js', () => ({
  getConfiguredOpenApiRules: () => state.rules,
  findConfiguredOpenApiPolicy: (product: string, action: string) =>
    state.rules.find((rule) => rule.product === product && rule.actions.includes(action)),
}));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({
    'output.format': 'json',
    'auth.token': 'synthetic-config-secret',
    'model.api_key': 'synthetic-config-secret',
  }),
}));

beforeEach(() => {
  state.calls.splice(0);
  state.data = {};
  state.failure = undefined;
  state.auth = 'valid';
  state.rules.splice(
    0,
    state.rules.length,
    {
      product: 'TestPortal',
      actions: ['ReadEntry'],
      auth: 'optional',
      response: 'success-code-envelope',
    },
    { product: 'OtherPortal', actions: ['ListEntries'], auth: 'optional' },
    { product: 'TestPortal', actions: ['PrivateEntry'], auth: 'required' },
  );
});
afterEach(() => vi.restoreAllMocks());

function descriptor(handler: PluginHandler): PluginDescriptor {
  return {
    name: '@example/api-probe',
    version: '1.0.0',
    manifest: { command: 'probe', entry: './index.js', handlerKey: 'probe', auth: 'optional' },
    loadHandlers: async () => ({ handlers: { probe: handler } }),
  };
}

async function run(handler: PluginHandler, trustedDefault = true): Promise<void> {
  const program = new Command();
  registerPluginCommands(program, [descriptor(handler)], { trustedDefault });
  await program.parseAsync(['probe'], { from: 'user' });
}

describe('default plugin backend API admission', () => {
  it('forwards valid backend operations without a plugin API policy', async () => {
    state.data = { Success: false, Code: 'BUSINESS_VALUE', Data: { amount: '001.20' } };
    await run(async (context) => {
      await expect(
        context.callOpenApi('FuturePortal', 'CreateEntry', { enabled: false }),
      ).resolves.toBe(state.data);
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].authMode).toBe('required');
    expect(JSON.parse(state.calls[0].body ?? '{}')).toMatchObject({
      product: 'FuturePortal',
      action: 'CreateEntry',
      params: { enabled: 'false' },
    });
  });

  it.each([
    ['sfm_bailian', 'BroadScopeAspnGateway'],
    ['Workorder', 'CreateTicketNew'],
    ['WebsitePortal', 'ListModelSeries'],
  ])('leaves %s/%s admission to the backend without retries', async (product, action) => {
    await run(async (context) => {
      await context.callOpenApi(product, action);
    });
    expect(state.calls).toHaveLength(1);
    expect(JSON.parse(state.calls[0].body ?? '{}')).toMatchObject({ product, action });
  });

  it.each([true, false])(
    'uses exact configured public pairs for trustedDefault=%s',
    async (trustedDefault) => {
      state.auth = null;
      await run(async (context) => {
        await context.callOpenApi('TestPortal', 'ReadEntry');
        await context.callOpenApi('OtherPortal', 'ListEntries');
        await context.callOpenApi('aliyun-search-maas', 'SearchAll');
      }, trustedDefault);
      expect(state.calls.map((call) => call.authMode)).toEqual([
        'optional',
        'optional',
        'optional',
      ]);
    },
  );

  it.each([
    ['TestPortal', 'PrivateEntry'],
    ['TestPortal', 'ListEntries'],
    ['OtherPortal', 'ReadEntry'],
    ['testportal', 'ReadEntry'],
    ['TestPortal ', 'ReadEntry'],
    ['TestPortal', 'readentry'],
    ['UnknownPortal', 'UnknownAction'],
  ])('requires login for a private or unmatched pair %s/%s', async (product, action) => {
    state.auth = null;
    expect(isPublicOpenApiOperation(product, action)).toBe(false);
    await run(async (context) => {
      await expect(context.callOpenApi(product, action)).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
        exitCode: 2,
      });
    });
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    ['TestPortal', 'ReadEntry'],
    ['aliyun-search-maas', 'SearchAll'],
    ['FuturePortal', 'PrivateEntry'],
  ])('does not downgrade expired credentials to anonymous for %s/%s', async (product, action) => {
    state.auth = 'expired';
    await run(async (context) => {
      await expect(context.callOpenApi(product, action)).rejects.toMatchObject({
        code: 'TOKEN_EXPIRED',
        exitCode: 2,
      });
    });
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    { Success: true, Data: { items: [] } },
    { Success: false, Code: 'DENIED', Data: null },
    { success: true, data: false },
  ])(
    'keeps SDK responses raw even when the API command has an envelope profile: %j',
    async (envelope) => {
      state.data = envelope;
      await run(async (context) => {
        await expect(context.callOpenApi('TestPortal', 'ReadEntry')).resolves.toBe(envelope);
      });
      expect(state.calls).toHaveLength(1);
    },
  );

  it('keeps credentials and the raw client outside the plugin context', async () => {
    await run(async (context) => {
      expect(context).not.toHaveProperty('token');
      expect(context).not.toHaveProperty('credentials');
      expect(context).not.toHaveProperty('apiClient');
      expect(JSON.stringify(context)).not.toContain('synthetic-default-credential');
      expect(JSON.stringify(context)).not.toContain('synthetic-config-secret');
      await context.callOpenApi('FuturePortal', 'ReadEntry', {
        product: 'OtherPortal',
        action: 'OtherAction',
        authOptional: true,
        url: 'https://override.test.qianwenai.com',
        headers: { Authorization: 'business-field' },
      });
    });
    const body = JSON.parse(state.calls[0].body ?? '{}') as {
      product: string;
      action: string;
      params: Record<string, string>;
    };
    expect(body).toMatchObject({
      product: 'FuturePortal',
      action: 'ReadEntry',
      params: { product: 'OtherPortal', action: 'OtherAction', authOptional: 'true' },
    });
    expect(state.calls[0].authMode).toBe('required');
  });

  it.each([
    { product: '' },
    { action: '   ' },
    { product: null },
    { action: 4 },
    { params: [] },
    { params: null },
    { params: 'invalid-params' },
  ])('rejects invalid runtime inputs before transport: %j', async (invalid) => {
    const args = { product: 'TestPortal', action: 'ReadEntry', params: undefined, ...invalid };
    await run(async (context) => {
      await expect(
        context.callOpenApi(
          args.product as string,
          args.action as string,
          args.params as unknown as Record<string, unknown> | undefined,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', exitCode: 4 });
    });
    expect(state.calls).toHaveLength(0);
  });
});
