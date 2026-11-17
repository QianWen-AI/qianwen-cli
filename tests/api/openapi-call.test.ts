import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createApiPolicyTestRoot,
  removeApiPolicyPluginRecord,
  seedApiPolicyPlugin,
} from '../fixtures/api-policy-plugin.js';

const policyDirectory = vi.hoisted(() => ({ root: '' }));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getConfigDir: () => policyDirectory.root,
  getPluginsDir: () => join(policyDirectory.root, 'plugins'),
  getPluginsManifestPath: () => join(policyDirectory.root, 'plugins.json'),
}));

const { credentialState, ensureAuthenticated, resolveCredentials, getCredentials } = vi.hoisted(
  () => {
    const state: { value: { access_token: string } | null } = { value: null };
    return {
      credentialState: state,
      ensureAuthenticated: vi.fn(() => state.value),
      resolveCredentials: vi.fn(() => state.value),
      getCredentials: vi.fn(() => state.value),
    };
  },
);

vi.mock('../../src/auth/credentials.js', () => ({
  ensureAuthenticated,
  resolveCredentials,
  getCredentials,
}));
vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../src/site.js', async (original) => {
  const actual = await original<typeof import('../../src/site.js')>();
  return { ...actual, site: { ...actual.site, apiEndpoint: 'https://api.test.qianwenai.com' } };
});

import { OpenApiService } from '../../src/services/openapi-service.js';
import { createApiClient } from '../../src/api/api-client.js';
import { createBaseClient, RequestTimeoutError } from '../../src/api/base-client.js';
import { authRequiredError, tokenExpiredError } from '../../src/utils/errors.js';

const privateCall = { product: 'AliyunDeliveryService', action: 'ListModelSeries' };
const unknownCall = { product: 'FutureProduct', action: 'CreateFutureResource' };
const publicCall = { product: 'WebsitePortal', action: 'SearchHub' };
const fakeCredential = ['synthetic', 'openapi', 'credential'].join('-');
const fetchMock = vi.fn<typeof fetch>();

function service(timeout = 1_000) {
  return new OpenApiService(createApiClient({ baseClient: createBaseClient({ timeout }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  policyDirectory.root = createApiPolicyTestRoot('openapi-transport-');
  vi.stubEnv('QIANWEN_CONFIG_DIR', policyDirectory.root);
  seedApiPolicyPlugin(policyDirectory.root);
  credentialState.value = { access_token: fakeCredential };
  ensureAuthenticated.mockReset().mockImplementation(() => {
    if (!credentialState.value) throw authRequiredError();
    return credentialState.value;
  });
  resolveCredentials.mockReset().mockImplementation(() => credentialState.value);
  getCredentials.mockReset().mockImplementation(() => credentialState.value);
  fetchMock.mockReset().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { action: string };
    const data =
      request.action === 'SearchHub' ? { Success: true, Data: { items: [] } } : { items: [] };
    return new Response(JSON.stringify({ code: '200', data }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(policyDirectory.root, { recursive: true, force: true });
});

describe('api call real Type A client / transport boundary', () => {
  it('rejects unauthenticated SearchHub requests without installed plugin policies and sends no HTTP', async () => {
    removeApiPolicyPluginRecord(policyDirectory.root);
    credentialState.value = null;

    await expect(service().call(publicCall)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      exitCode: 2,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the raw business envelope for authenticated SearchHub requests without installed plugin policies', async () => {
    removeApiPolicyPluginRecord(policyDirectory.root);
    const data = { Success: false, Code: 'BUSINESS_VALUE', Data: { preserved: true } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '200', data })));

    await expect(service().call(publicCall)).resolves.toEqual(data);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      `Bearer ${fakeCredential}`,
    );
  });

  it('uses the fixed site gateway and cn-beijing, flattening business params without overriding routing or authentication', async () => {
    const data = {
      success: false,
      code: 'BusinessValue',
      amount: '0001.20',
      data: { records: [1] },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: '200', data }), { status: 200 }),
    );
    const params = {
      Language: 'zh-CN',
      n: 2,
      enabled: false,
      nested: { ids: [1, 2] },
      list: ['a', 'b'],
      product: 'sfm_bailian',
      action: 'BroadScopeAspnGateway',
      region: 'other-region',
      url: 'https://override.test.qianwenai.com',
      authMode: 'none',
      authOptional: true,
      headers: { 'X-Test': 'business-only' },
    };
    const result = await service().call({ ...privateCall, params });
    expect(result).toEqual(data);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.test.qianwenai.com/data/v2/api.json');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${fakeCredential}`);
    expect(new Headers(init?.headers).get('X-Test')).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({
      ...privateCall,
      region: 'cn-beijing',
      params: {
        Language: 'zh-CN',
        n: '2',
        enabled: 'false',
        nested: '{"ids":[1,2]}',
        list: '["a","b"]',
        product: 'sfm_bailian',
        action: 'BroadScopeAspnGateway',
        region: 'other-region',
        url: 'https://override.test.qianwenai.com',
        authMode: 'none',
        authOptional: 'true',
        headers: '{"X-Test":"business-only"}',
      },
    });
    expect(String(init?.body)).not.toContain(fakeCredential);
    expect(JSON.stringify(result)).not.toContain(fakeCredential);
  });

  it.each([
    unknownCall,
    { product: 'WebsitePortal', action: 'ListModelSeries' },
    { product: 'sfm_bailian', action: 'BroadScopeAspnGateway' },
    { product: 'BssOpenAPI-V3', action: 'BroadScopeAspnGateway' },
    { product: 'Workorder', action: 'CreateTicketNew' },
    { product: 'WebsitePortal', action: 'GetHubSkill' },
  ])(
    'passes valid $product/$action values unchanged to the fixed Type A gateway',
    async (options) => {
      await expect(service().call(options)).resolves.toEqual({ items: [] });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe('https://api.test.qianwenai.com/data/v2/api.json');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${fakeCredential}`);
      expect(JSON.parse(String(init?.body))).toMatchObject({ ...options, region: 'cn-beijing' });
    },
  );

  it.each([
    unknownCall,
    { product: 'WebsitePortal', action: 'ListModelSeries' },
    { product: 'OtherProduct', action: 'SearchHub' },
    { product: 'WebsitePortal', action: 'SearchAll' },
    { product: 'aliyun-search-maas', action: 'SearchHub' },
    { product: 'websiteportal', action: 'SearchHub' },
    { product: 'WebsitePortal', action: 'searchhub' },
    { product: 'WebsitePortal ', action: 'SearchHub' },
  ])(
    'requires login by default for $product/$action unless explicitly public and sends no HTTP',
    async (options) => {
      credentialState.value = null;
      await expect(service().call(options)).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
        exitCode: 2,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('reports authentication failure for private calls without login and sends no request', async () => {
    credentialState.value = null;
    await expect(service().call(privateCall)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      exitCode: 2,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([publicCall, { product: 'aliyun-search-maas', action: 'SearchAll' }])(
    'calls $product/$action anonymously under installed plugin policies or built-in declarations without Authorization',
    async (options) => {
      credentialState.value = null;
      await expect(service().call(options)).resolves.toEqual({ items: [] });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
    },
  );

  it('attaches host credentials to SearchHub requests when logged in', async () => {
    await service().call(publicCall);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      `Bearer ${fakeCredential}`,
    );
  });

  it.each([
    privateCall,
    publicCall,
    unknownCall,
    { product: 'aliyun-search-maas', action: 'SearchAll' },
  ])(
    'does not fall back to anonymous access for $product/$action with expired credentials',
    async (options) => {
      const expired = tokenExpiredError();
      ensureAuthenticated.mockImplementation(() => {
        throw expired;
      });
      resolveCredentials.mockImplementation(() => {
        throw expired;
      });
      getCredentials.mockImplementation(() => {
        throw expired;
      });
      await expect(service().call(options)).rejects.toMatchObject({
        code: 'TOKEN_EXPIRED',
        exitCode: 2,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects an outer failure code on HTTP 200 instead of treating it as business data and does not retry', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: '403',
          message: 'forbidden synthetic request',
          data: { items: [] },
        }),
        { status: 200 },
      ),
    );
    await expect(service().call(unknownCall)).rejects.toMatchObject({
      name: 'GatewayEnvelopeError',
      code: '403',
      message: 'forbidden synthetic request',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('propagates a fetch error after rejecting a redirect without sending a second request', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: unexpected redirect'));
    await expect(service().call(privateCall)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('propagates an in-flight AbortSignal to real fetch and removes the external signal listener', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    fetchMock.mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = service().call({ ...unknownCall, signal: controller.signal });
    const observed = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new DOMException('cancel synthetic request', 'AbortError'));
    const error = await observed;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    for (const [event, handler] of add.mock.calls) {
      if (event === 'abort')
        expect(
          remove.mock.calls.some(
            ([removedEvent, removedHandler]) =>
              removedEvent === event && removedHandler === handler,
          ),
        ).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves RequestTimeoutError on a real timeout without retrying', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new DOMException('timeout', 'AbortError')),
            { once: true },
          );
        }),
    );
    const observed = service(25)
      .call(unknownCall)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(26);
    expect(await observed).toBeInstanceOf(RequestTimeoutError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('conflicting built-in anonymous capability', () => {
  it.each([false, true])(
    'conflict blocks SearchAll without HTTP for reverse order %s; disabling owner restores it',
    async (reverse) => {
      const operation = { product: 'aliyun-search-maas', action: 'SearchAll' };
      seedApiPolicyPlugin(policyDirectory.root, [
        { product: operation.product, actions: [operation.action], auth: 'optional' },
      ]);
      const name = '@qianwenai/policy-conflict';
      const directory = join(policyDirectory.root, 'plugins', 'node_modules', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          qianwen: {
            command: 'policyconflict',
            entry: './index.mjs',
            handlerKey: 'run',
            auth: 'optional',
            minCliVersion: '1.0.0',
            apiPolicy: [
              { product: operation.product, actions: [operation.action], auth: 'required' },
            ],
          },
        }),
      );
      writeFileSync(join(directory, 'index.mjs'), 'export const handlers = { run() {} };');
      const manifestPath = join(policyDirectory.root, 'plugins.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        plugins: Array<{ name: string; version: string; enabled: boolean; source: string }>;
      };
      manifest.plugins.push({ name, version: '1.0.0', enabled: true, source: 'npm' });
      if (reverse) manifest.plugins.reverse();
      writeFileSync(manifestPath, JSON.stringify(manifest));
      credentialState.value = null;
      await expect(service().call(operation)).rejects.toMatchObject({
        code: 'PLUGIN_API_POLICY_CONFLICT',
        exitCode: 4,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const owner = manifest.plugins.find((plugin) => plugin.name === name);
      if (!owner) throw new Error('missing fixture owner');
      owner.enabled = false;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      await expect(service().call(operation)).resolves.toEqual({ items: [] });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
});
