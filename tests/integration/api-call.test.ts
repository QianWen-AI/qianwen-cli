import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Credentials } from '../../src/types/auth.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from './helpers.js';
import { clearRenderedFrames, lastRenderedFrame } from '../helpers/ink-render-mock.js';
import { createProgram } from '../../src/cli.js';
import { collectReservedNames, resolvePluginConflict } from '../../src/plugins/loader.js';
import {
  createApiPolicyTestRoot,
  removeApiPolicyPluginRecord,
  seedApiPolicyPlugin,
} from '../fixtures/api-policy-plugin.js';

const state = vi.hoisted(() => ({ root: `${process.cwd()}/.build-tmp/api-call-unused` }));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getConfigDir: () => state.root,
  getGlobalConfigPath: () => join(state.root, 'config.json'),
  getLocalConfigPath: () => join(state.root, '.qianwen.json'),
  getPluginsDir: () => join(state.root, 'plugins'),
  getPluginsManifestPath: () => join(state.root, 'plugins.json'),
  getCacheDir: () => join(state.root, 'cache'),
  getCacheFilePath: (name: string) => join(state.root, 'cache', name),
}));
vi.mock('../../src/auth/credentials.js', async (original) => ({
  ...(await original<typeof import('../../src/auth/credentials.js')>()),
  getCredentials: vi.fn(() => null),
  resolveCredentials: vi.fn(() => null),
  ensureAuthenticated: vi.fn(() => {
    throw authRequiredError();
  }),
}));
vi.mock('../../src/site.js', async (original) => {
  const actual = await original<typeof import('../../src/site.js')>();
  return { ...actual, site: { ...actual.site, apiEndpoint: 'https://api.test.qianwenai.com' } };
});
vi.mock('../../src/ui/render.js', async (original) => {
  const { renderInkForTest } = await import('../helpers/ink-render-mock.js');
  return {
    ...(await original<typeof import('../../src/ui/render.js')>()),
    renderWithInk: renderInkForTest,
  };
});

import { authRequiredError, tokenExpiredError } from '../../src/utils/errors.js';
import { resolveCredentials, ensureAuthenticated } from '../../src/auth/credentials.js';
import { resetGlobalCache, resetGlobalFileCache } from '../../src/utils/cache.js';

const args = ['api', 'call', '--product', 'WebsitePortal', '--action', 'SearchHub'];
const fetchMock = vi.fn<typeof fetch>();
let tty: PropertyDescriptor | undefined;

beforeEach(() => {
  state.root = createApiPolicyTestRoot('qianwen-api-call-');
  vi.stubEnv('QIANWEN_CONFIG_DIR', state.root);
  seedApiPolicyPlugin(state.root);
  resetGlobalCache();
  resetGlobalFileCache();
  tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  vi.stubEnv('QIANWEN_API_ENDPOINT', '');
  vi.stubEnv('DEBUG_HTTP', '');
  clearRenderedFrames();
  fetchMock.mockReset().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          code: '200',
          data: { Success: true, Data: { items: [{ title: '中文', count: 0 }], total: 1 } },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(resolveCredentials).mockReset().mockReturnValue(null);
  vi.mocked(ensureAuthenticated)
    .mockReset()
    .mockImplementation(() => {
      throw authRequiredError();
    });
});

afterEach(() => {
  if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
  resetGlobalCache();
  resetGlobalFileCache();
  rmSync(state.root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('api call complete CLI integration', () => {
  it('rejects anonymous SearchHub requests without installed plugins and does not prepare plugins automatically', async () => {
    removeApiPolicyPluginRecord(state.root);

    const result = await runCommand([...args, '--format', 'json']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'AUTH_REQUIRED', exit_code: 2 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('outputs raw Type A data for authenticated SearchHub requests without installed plugins', async () => {
    removeApiPolicyPluginRecord(state.root);
    const credential: Credentials = {
      access_token: 'synthetic-cli-credential',
      expires_at: '2099-01-01T00:00:00Z',
      user: { email: 'fixture@test.qianwenai.com', aliyunId: 'fixture-user' },
    };
    vi.mocked(resolveCredentials).mockReturnValue({
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: credential.access_token,
      credentials: credential,
    });
    vi.mocked(ensureAuthenticated).mockReturnValue(credential);
    const data = { Success: false, Code: 'BUSINESS_VALUE', Data: { preserved: true } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '200', data })));

    const result = await runCommand([...args, '--format', 'json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(data);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer synthetic-cli-credential',
    );
  });

  it.each(['api'])(
    'reserves %s against both plugin names and aliases in the actual command tree',
    (name) => {
      const reserved = collectReservedNames(createProgram());
      expect(reserved.has(name)).toBe(true);
      expect(resolvePluginConflict([name], reserved, [])).toBe('reserved');
      expect(resolvePluginConflict(['synthetic-plugin', name], reserved, [])).toBe('reserved');
    },
  );

  it.each([
    ['api', '--help'],
    ['api', 'call', '--help'],
    [...args, '--help', '--format', 'json'],
  ])('keeps valid help successful without credentials or transport: %j', async (...argv) => {
    const result = await runCommand(argv);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage:');
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { Success: false, Code: 'NOT_FOUND', Message: 'synthetic Hub failure', Data: { items: [] } },
    { success: false, code: 'NOT_FOUND', message: 'synthetic Hub failure' },
  ])('surfaces a failed inner Hub envelope through the actual CLI as API_ERROR/1', async (data) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '200', data })));
    const result = await runCommand([...args, '--format', 'json']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'API_ERROR', exit_code: 1 } });
    expect(result.stderr).toContain('synthetic Hub failure');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([{ Success: true }, { success: true }, { items: [] }, null])(
    'rejects malformed Hub output through the CLI as API_RESPONSE_INVALID/6: %j',
    async (data) => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '200', data })));
      const result = await runCommand([...args, '--format', 'json']);
      expect(result.exitCode).toBe(6);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: 'API_RESPONSE_INVALID', exit_code: 6 },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('unwraps camelCase Hub success while preserving business status fields inside its payload', async () => {
    const payload = { success: false, code: 'BUSINESS_VALUE', data: { count: 0 } };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: '200', data: { code: 200, data: payload } })),
    );
    const result = await runCommand([...args, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('exposes the command and options in root and subcommand help', async () => {
    expect((await runCommand(['--help'])).stdout).toContain('api');
    expect((await runCommand(['api', '--help'])).stdout).toContain('call');
    expect((await runCommand(['api', 'call', '--help'])).stdout).toContain('--params');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('sends one request through the real DI/service/adapter chain and outputs business JSON', async () => {
    const result = await runCommand([...args, '--params', '{"Query":"demo"}', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ items: [{ title: '中文', count: 0 }], total: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).params).toEqual({
      Query: 'demo',
    });
  });

  it('uses the existing non-TTY table fallback without mounting Ink', async () => {
    vi.stubEnv('VITEST', '');
    const result = await runCommand([...args, '--format', 'table']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('falling back to text');
    expect(result.stdout).toContain('FIELD');
    expect(result.stdout).toContain('{"title":"中文","count":0}');
    expect(lastRenderedFrame()).toBeUndefined();
  });

  it('runs the actual Ink component for TTY table output and preserves nested data', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const result = await runCommand([...args, '--format', 'table']);
    expect(result.exitCode).toBe(0);
    expect(lastRenderedFrame()).toContain('FIELD');
    expect(lastRenderedFrame()).toContain('VALUE');
    expect(lastRenderedFrame()).toContain('中文');
    expect(lastRenderedFrame()).toContain('total');
  });

  it.each([
    ['FutureProduct', 'CreateFutureResource'],
    ['WebsitePortal', 'ListModelSeries'],
    ['sfm_bailian', 'BroadScopeAspnGateway'],
    ['Workorder', 'CreateTicketNew'],
    ['AliyunDeliveryService ', ' ListModelSeries'],
  ])('requests %s/%s once through the real CLI with valid credentials', async (product, action) => {
    const credential: Credentials = {
      access_token: 'synthetic-cli-credential',
      expires_at: '2099-01-01T00:00:00Z',
      user: { email: 'fixture@test.qianwenai.com', aliyunId: 'fixture-user' },
    };
    vi.mocked(resolveCredentials).mockReturnValue({
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: credential.access_token,
      credentials: credential,
    });
    vi.mocked(ensureAuthenticated).mockReturnValue(credential);
    const data = { Success: false, Code: 'BUSINESS_VALUE', Data: { preserved: true } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '200', data })));
    const result = await runCommand([
      'api',
      'call',
      '--product',
      product,
      '--action',
      action,
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(data);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      product,
      action,
      region: 'cn-beijing',
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer synthetic-cli-credential',
    );
    expect(result.stdout + result.stderr).not.toContain('synthetic-cli-credential');
  });

  it('rejects unauthenticated unknown pairs at the authentication boundary with AUTH_REQUIRED/2 and no HTTP', async () => {
    const result = await runCommand([
      'api',
      'call',
      '--product',
      'FutureProduct',
      '--action',
      'CreateFutureResource',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'AUTH_REQUIRED', exit_code: 2 },
    });
    expect(result.stdout).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['WebsitePortal', 'SearchHub'],
    ['FutureProduct', 'CreateFutureResource'],
  ])(
    'rejects expired credentials for %s/%s through the real CLI without anonymous fallback',
    async (product, action) => {
      vi.mocked(resolveCredentials).mockImplementation(() => {
        throw tokenExpiredError();
      });
      const result = await runCommand([
        'api',
        'call',
        '--product',
        product,
        '--action',
        action,
        '--format',
        'json',
      ]);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: 'TOKEN_EXPIRED', exit_code: 2 },
      });
      expect(result.stdout).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['--product', '', '--action', 'WriteAction'],
    ['--product', 'FutureProduct', '--action', ' \t '],
    ['--product', 'FutureProduct', '--action', 'WriteAction', '--params', 'null'],
    ['--product', 'FutureProduct', '--action', 'WriteAction', '--params', '[]'],
    [
      '--product',
      'FutureProduct',
      '--action',
      'WriteAction',
      '--params',
      '{"private":"private-input-marker"',
    ],
  ])(
    'returns INVALID_ARGUMENT/4 for invalid input %j through the real CLI before HTTP',
    async (...invalid) => {
      const result = await runCommand(['api', 'call', ...invalid, '--format', 'json']);
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: 'INVALID_ARGUMENT', exit_code: 4 },
      });
      expect(result.stderr).not.toContain('private-input-marker');
      expect(result.stdout).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('preserves backend rejection messages and classification for unknown pairs without substituting a local access error or retrying', async () => {
    const credential: Credentials = {
      access_token: 'synthetic-cli-credential',
      expires_at: '2099-01-01T00:00:00Z',
      user: { email: 'fixture@test.qianwenai.com', aliyunId: 'fixture-user' },
    };
    vi.mocked(resolveCredentials).mockReturnValue({
      source: 'encrypted_file',
      auth_mode: 'device_flow',
      access_token: credential.access_token,
      credentials: credential,
    });
    vi.mocked(ensureAuthenticated).mockReturnValue(credential);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: '403', message: 'backend admission denied' })),
    );
    const result = await runCommand([
      'api',
      'call',
      '--product',
      'FutureProduct',
      '--action',
      'CreateFutureResource',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'API_ERROR', exit_code: 1 } });
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('backend admission denied');
    expect(result.stderr).not.toMatch(/API_FORBIDDEN/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects missing business data instead of printing non-JSON undefined as success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"code":"200"}'));
    const result = await runCommand([...args, '--format', 'json']);
    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stderr).error.code).toBe('API_RESPONSE_INVALID');
    expect(result.stdout).toBe('');
  });

  it.each([
    [401, 2],
    [403, 2],
    [429, 5],
    [500, 6],
  ])('maps real HTTP %i to exit %i using the shared classification', async (status, exitCode) => {
    fetchMock.mockResolvedValueOnce(new Response('synthetic failure', { status }));
    const result = await runCommand([...args, '--format', 'json']);
    expect(result.exitCode).toBe(exitCode);
    expect(JSON.parse(result.stderr).error.exit_code).toBe(exitCode);
    expect(result.stdout).toBe('');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves NETWORK_ERROR/3 for a real network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await runCommand([...args, '--format', 'json']);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe('NETWORK_ERROR');
    expect(result.stdout).toBe('');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('maps a real transport timeout to NETWORK_ERROR/3 at the command boundary', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = runCommand([...args, '--format', 'json']);
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe('NETWORK_ERROR');
    expect(result.stdout).toBe('');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('api child names are not reserved at plugin top level', () => {
  it.each([false, true])(
    'plugin call as alias=%s coexists with the real api call route',
    async (alias) => {
      const reserved = collectReservedNames(createProgram());
      expect(reserved.has('call')).toBe(false);
      expect(resolvePluginConflict(['call'], reserved, [])).toBe('ok');
      expect(resolvePluginConflict(['synthetic-plugin', 'call'], reserved, [])).toBe('ok');
      const name = '@qianwenai/call-fixture';
      const directory = join(state.root, 'plugins', 'node_modules', name);
      mkdirSync(directory, { recursive: true });
      const command = alias ? 'standalone-call' : 'call';
      const commandAliases = alias ? ['call'] : [];
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          qianwen: {
            command,
            commandAliases,
            entry: './index.mjs',
            handlerKey: 'run',
            auth: 'optional',
          },
        }),
      );
      writeFileSync(
        join(directory, 'index.mjs'),
        'export const handlers = { run() { console.log(JSON.stringify({ route: "plugin-call" })); } };',
      );
      const manifestPath = join(state.root, 'plugins.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { plugins: unknown[] };
      manifest.plugins.push({
        name,
        version: '1.0.0',
        command,
        commandAliases,
        enabled: true,
        source: 'npm',
      });
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const pluginResult = await runCommand(['call', '--format', 'json']);
      expect(pluginResult.exitCode).toBe(0);
      expect(JSON.parse(pluginResult.stdout)).toEqual({ route: 'plugin-call' });
      expect(fetchMock).not.toHaveBeenCalled();
      const builtinResult = await runCommand([...args, '--format', 'json']);
      expect(builtinResult.exitCode).toBe(0);
      expect(JSON.parse(builtinResult.stdout)).toEqual({
        items: [{ title: '中文', count: 0 }],
        total: 1,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        product: 'WebsitePortal',
        action: 'SearchHub',
      });
    },
  );
});
