import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { apiPolicyFixtureRules, createApiPolicyTestRoot } from '../fixtures/api-policy-plugin.js';
import { setCommandHidden, getCommandHelpGroup } from '../../src/utils/commander-helpers.js';
import {
  collectReservedNames,
  resolvePluginConflict,
  pluginNames,
  classifyInstallCollision,
  registerPluginCommands,
  loadInstalledPlugins,
} from '../../src/plugins/loader.js';
import type { PluginManifest, InstalledManifest } from '../../src/plugins/manifest.js';
import type { OpenApiPolicyRule } from '../../src/config/openapi-policy.js';

const policyState = vi.hoisted(() => ({ rules: [] as OpenApiPolicyRule[] }));
vi.mock('../../src/config/openapi-policy.js', () => ({
  getConfiguredOpenApiRules: () => policyState.rules,
  findConfiguredOpenApiPolicy: (product: string, action: string) =>
    policyState.rules.find((rule) => rule.product === product && rule.actions.includes(action)),
}));
vi.mock('../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({ 'output.format': 'json' }),
}));

vi.mock('../../src/site.js', async (original) => {
  const actual = await original<typeof import('../../src/site.js')>();
  return { ...actual, site: { ...actual.site, apiEndpoint: 'https://api.test.qianwenai.com' } };
});

const credState = vi.hoisted(() => ({ auth: null as null | 'valid' | 'expired' }));
const transportState = vi.hoisted(() => ({
  calls: [] as Array<{
    authMode?: string;
    body?: string;
    signal?: AbortSignal;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }>,
  data: {} as unknown,
  code: '200',
  error: undefined as unknown,
  waitForAbort: false,
}));

vi.mock('../../src/api/base-client.js', () => ({
  createBaseClient: () => ({
    request: vi.fn(async (options: { authMode?: string; body?: string; signal?: AbortSignal }) => {
      transportState.calls.push(options);
      if (transportState.error) throw transportState.error;
      if (transportState.waitForAbort) {
        await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
      }
      return {
        code: transportState.code,
        message: 'backend admission denied',
        data: transportState.data,
      };
    }),
  }),
}));

vi.mock('../../src/auth/credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/credentials.js')>();
  const errors = await import('../../src/utils/errors.js');
  return {
    ...actual,
    resolveCredentials: () =>
      credState.auth === null ? null : { access_token: 'synthetic-plugin-credential' },
    getCredentials: () =>
      credState.auth === null ? null : { access_token: 'synthetic-plugin-credential' },
    ensureAuthenticated: () => {
      if (credState.auth === null) throw errors.authRequiredError();
      if (credState.auth === 'expired') throw errors.tokenExpiredError();
      return {
        access_token: 'synthetic-plugin-credential',
        expires_at: '2099-01-01T00:00:00Z',
        user: undefined,
      };
    },
  };
});

beforeEach(() => {
  transportState.calls.length = 0;
  transportState.data = {};
  transportState.code = '200';
  transportState.error = undefined;
  transportState.waitForAbort = false;
  credState.auth = 'valid';
  policyState.rules = apiPolicyFixtureRules();
});

function makeProgram(): Command {
  const program = new Command();
  program.command('models').description('Models').alias('m');
  const login = program.command('login').description('Login').aliases(['signin']);
  setCommandHidden(login, true);
  return program;
}

describe('collectReservedNames', () => {
  it('does not reserve names or aliases belonging only to nested built-in commands', () => {
    const program = makeProgram();
    program.command('parent').command('nested-only').alias('nested-alias');
    const reserved = collectReservedNames(program);
    expect(reserved.has('parent')).toBe(true);
    expect(reserved.has('nested-only')).toBe(false);
    expect(reserved.has('nested-alias')).toBe(false);
  });

  it('collects built-in command names, including hidden login', () => {
    const reserved = collectReservedNames(makeProgram());
    expect(reserved.has('models')).toBe(true);
    expect(reserved.has('login')).toBe(true);
  });

  it('collects built-in aliases so plugins cannot claim them', () => {
    const reserved = collectReservedNames(makeProgram());
    expect(reserved.has('m')).toBe(true);
    expect(reserved.has('signin')).toBe(true);
  });
});

describe('resolvePluginConflict', () => {
  const reserved = new Set(['models', 'login', 'm']);

  it('reports reserved for collisions with built-in command names', () => {
    expect(resolvePluginConflict(['models'], reserved, [])).toBe('reserved');
  });

  it('reports reserved for collisions with built-in aliases', () => {
    expect(resolvePluginConflict(['m'], reserved, [])).toBe('reserved');
  });

  it('reports duplicate for collisions with an installed plugin name', () => {
    expect(resolvePluginConflict(['foo'], reserved, ['foo'])).toBe('duplicate');
  });

  it('accepts names without collisions', () => {
    expect(resolvePluginConflict(['brandnew'], reserved, ['foo'])).toBe('ok');
  });

  it('reports reserved when a plugin alias collides with a built-in', () => {
    // The command is distinct, but alias "m" collides with a built-in and must reject the plugin.
    expect(resolvePluginConflict(['brandnew', 'm'], reserved, [])).toBe('reserved');
  });

  it('reports duplicate when a plugin alias collides with an installed plugin name', () => {
    expect(resolvePluginConflict(['brandnew', 'taken'], reserved, ['taken'])).toBe('duplicate');
  });
});

describe('pluginNames — normalize commands and aliases, deduplicate, and remove empty names', () => {
  it('expands commands and aliases, strips argument syntax, deduplicates, and removes empty names', () => {
    expect(pluginNames('foo [x]', ['bar', 'foo', ''])).toEqual(['foo', 'bar']);
  });
  it('returns only the command when there are no aliases', () => {
    expect(pluginNames('foo', undefined)).toEqual(['foo']);
  });
});

describe('classifyInstallCollision — alias checks', () => {
  const reserved = new Set(['models', 'm']);
  const installed = [
    {
      name: 'other',
      version: '1.0.0',
      enabled: true,
      source: 'npm' as const,
      command: 'greet',
      commandAliases: ['g'],
    },
  ];

  it('reports duplicate when a new plugin command collides with an installed alias', () => {
    expect(classifyInstallCollision('g', undefined, reserved, installed, 'self')).toBe('duplicate');
  });
  it('reports duplicate when a new plugin alias collides with an installed command', () => {
    expect(classifyInstallCollision('brandnew', ['greet'], reserved, installed, 'self')).toBe(
      'duplicate',
    );
  });
  it('reports reserved when a new plugin alias collides with a built-in alias', () => {
    expect(classifyInstallCollision('brandnew', ['m'], reserved, installed, 'self')).toBe(
      'reserved',
    );
  });
  it('allows a plugin to retain its command and aliases during reinstallation', () => {
    // The same plugin owns greet and g, so reinstallation must also exempt alias g.
    expect(classifyInstallCollision('greet', ['g'], reserved, installed, 'other')).toBe('ok');
  });
  it('reports reserved when reinstallation retains its command but adds a built-in alias', () => {
    expect(classifyInstallCollision('greet', ['g', 'models'], reserved, installed, 'other')).toBe(
      'reserved',
    );
  });
  it('reports duplicate when reinstallation retains its command but adds another plugin name', () => {
    const withSecond = [
      ...installed,
      {
        name: 'second',
        version: '1.0.0',
        enabled: true,
        source: 'npm' as const,
        command: 'second-command',
      },
    ];
    expect(
      classifyInstallCollision('greet', ['g', 'second-command'], reserved, withSecond, 'other'),
    ).toBe('duplicate');
  });
  it('accepts an unused name', () => {
    expect(classifyInstallCollision('brandnew', ['bn'], reserved, installed, 'self')).toBe('ok');
  });
});

describe('registerPluginCommands', () => {
  it('creates command stubs from the manifest without importing the implementation', () => {
    const program = new Command();
    const manifest: PluginManifest = {
      command: 'demo',
      description: 'Demo plugin',
      entry: './index.js',
      handlerKey: 'demo',
    };
    registerPluginCommands(program, [{ name: 'demo', pkgDir: '/fake/demo', manifest }]);
    const demo = program.commands.find((c) => c.name() === 'demo');
    expect(demo).toBeDefined();
    expect(demo!.description()).toBe('Demo plugin');
  });

  it('skips a plugin that collides with a built-in without registering it or crashing', () => {
    const program = new Command();
    program.command('models').description('builtin');
    const manifest: PluginManifest = { command: 'models', entry: './i.js', handlerKey: 'models' };
    expect(() =>
      registerPluginCommands(program, [{ name: 'evil', pkgDir: '/fake', manifest }]),
    ).not.toThrow();
    const models = program.commands.filter((c) => c.name() === 'models');
    expect(models).toHaveLength(1);
    expect(models[0].description()).toBe('builtin');
  });

  it('contains stub creation errors without affecting other plugins', () => {
    const program = new Command();
    const bad = { name: 'bad', pkgDir: '/fake', manifest: null as unknown as PluginManifest };
    const good: PluginManifest = { command: 'good', entry: './i.js', handlerKey: 'good' };
    expect(() =>
      registerPluginCommands(program, [bad, { name: 'good', pkgDir: '/fake', manifest: good }]),
    ).not.toThrow();
    expect(program.commands.find((c) => c.name() === 'good')).toBeDefined();
  });
});

describe('registerPluginCommands — leaf actions and lazy entry loading', () => {
  it('attaches a leaf action that imports the entry only when invoked', () => {
    const program = new Command();
    const manifest: PluginManifest = {
      command: 'hello',
      entry: './index.mjs',
      handlerKey: 'hello',
    };
    registerPluginCommands(program, [{ name: 'hello', pkgDir: '/fake', manifest }]);

    const hello = program.commands.find((c) => c.name() === 'hello')!;
    expect(typeof (hello as unknown as { _actionHandler: unknown })._actionHandler).toBe(
      'function',
    );
  });

  it('attaches leaf actions to subcommands while keeping the parent a group', () => {
    const program = new Command();
    const manifest: PluginManifest = {
      command: 'grp',
      entry: './i.mjs',
      subcommands: [{ command: 'sub', handlerKey: 'grp.sub' }],
    };
    registerPluginCommands(program, [{ name: 'grp', pkgDir: '/fake', manifest }]);

    const grp = program.commands.find((c) => c.name() === 'grp')!;
    expect(grp.commands.find((c) => c.name() === 'sub')).toBeDefined();
  });

  it('imports the top-level entry for a subcommand leaf instead of falling back to index.js', async () => {
    const program = new Command();
    program.exitOverride();
    const manifest: PluginManifest = {
      command: 'grp',
      entry: './sub-entry.mjs',
      subcommands: [{ command: 'sub', handlerKey: 'grp.sub' }],
    };
    registerPluginCommands(program, [{ name: 'grp', pkgDir: '/no-such-dir', manifest }]);

    // Capture stderr to verify that the leaf loads the configured top-level entry.
    let captured = '';
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      captured += a.join(' ');
    });
    const wrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stderr.write);
    await expect(program.parseAsync(['grp', 'sub'], { from: 'user' })).rejects.toThrow();
    errSpy.mockRestore();
    wrSpy.mockRestore();
    expect(captured).toMatch(/sub-entry\.mjs/);
  });
});

describe('registerPluginCommands — warnings and arguments', () => {
  it('warns on stderr when a plugin name collides with a built-in', () => {
    const program = new Command();
    program.command('models').description('builtin');
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const manifest: PluginManifest = { command: 'models', entry: './i.mjs', handlerKey: 'models' };

    registerPluginCommands(program, [{ name: 'evil', pkgDir: '/fake', manifest }]);

    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/collides with a built-in/));
    spy.mockRestore();
  });

  it('rejects and warns about a missing manifest entry without creating a stub', () => {
    const program = new Command();
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const manifest = { command: 'noentry', handlerKey: 'noentry' } as PluginManifest;

    registerPluginCommands(program, [{ name: 'noentry', pkgDir: '/fake', manifest }]);

    expect(program.commands.find((c) => c.name() === 'noentry')).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/missing "entry"/));
    spy.mockRestore();
  });

  it('S3: warns and skips stub creation when minCliVersion exceeds the current CLI version', () => {
    const program = new Command();
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const manifest: PluginManifest = {
      command: 'needsnew',
      entry: './i.mjs',
      handlerKey: 'run',
      minCliVersion: '99.0.0',
    };
    registerPluginCommands(program, [{ name: 'needsnew', pkgDir: '/fake', manifest }]);

    expect(program.commands.find((c) => c.name() === 'needsnew')).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/requires CLI >= 99\.0\.0/));
    spy.mockRestore();
  });

  it('S3: creates a stub when minCliVersion is satisfied (0.0.1)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command();
    const manifest: PluginManifest = {
      command: 'okver',
      entry: './entry.mjs',
      handlerKey: 'echo',
      minCliVersion: '0.0.1',
    };
    registerPluginCommands(program, [{ name: 'okver', pkgDir, manifest }]);
    expect(program.commands.find((c) => c.name() === 'okver')).toBeDefined();
  });

  it.each(['not-semver', '', ' ', '\t\n'])(
    'reports invalid minimum CLI metadata %j instead of an incompatibility',
    (minCliVersion) => {
      const program = new Command();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const manifest: PluginManifest = {
        command: 'invalidver',
        entry: './i.mjs',
        handlerKey: 'run',
        minCliVersion,
      };

      registerPluginCommands(program, [{ name: 'invalidver', pkgDir: '/fake', manifest }]);

      expect(program.commands.find((command) => command.name() === 'invalidver')).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/invalid minCliVersion/));
      expect(spy.mock.calls.map(([message]) => String(message)).join('')).not.toMatch(
        /requires CLI|incompatible/i,
      );
      spy.mockRestore();
    },
  );

  async function probeCall(request: Record<string, unknown>) {
    const pkgDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apiplugin');
    const program = new Command().exitOverride();
    const manifest: PluginManifest = {
      command: 'apip <request>',
      entry: './entry.mjs',
      handlerKey: 'probeCall',
    };
    registerPluginCommands(program, [{ name: 'apip', pkgDir, manifest }]);
    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += String(chunk);
      return true;
    });
    try {
      await program.parseAsync(['apip', JSON.stringify(request)], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    return { value: JSON.parse(captured), output: captured };
  }

  it('forwards valid unknown pairs without exposing credentials in ctx', async () => {
    transportState.data = { success: false, code: 'BUSINESS_VALUE', data: { amount: '001.20' } };
    const request = {
      product: 'FutureProduct',
      action: 'CreateFutureResource',
      params: { enabled: false },
    };
    const { value, output } = await probeCall(request);
    expect(value).toEqual({
      hasFn: true,
      keys: [
        'abort',
        'callOpenApi',
        'config',
        'directory',
        'errors',
        'format',
        'runtime',
        'terminal',
      ],
      result: transportState.data,
    });
    expect(output).not.toContain('synthetic-plugin-credential');
    expect(transportState.calls).toHaveLength(1);
    expect(transportState.calls[0]?.authMode).toBe('required');
    expect(JSON.parse(transportState.calls[0]?.body ?? '{}')).toEqual({
      product: request.product,
      action: request.action,
      region: 'cn-beijing',
      params: { enabled: 'false' },
    });
  });

  it.each([
    ['sfm_bailian', 'BroadScopeAspnGateway'],
    ['sfm_bailian', 'ListModelSeries'],
    ['BssOpenAPI-V3', 'BroadScopeAspnGateway'],
    ['Workorder', 'CreateTicketNew'],
    ['Workorder', 'CancelTicket'],
    ['WebsitePortal', 'ListModelSeries'],
    ['AliyunDeliveryService ', ' ListModelSeries'],
  ])('SDK forwards %s/%s without special rejection or pair rewriting', async (product, action) => {
    const { value } = await probeCall({ product, action });
    expect(value.error).toBeUndefined();
    expect(transportState.calls).toHaveLength(1);
    expect(JSON.parse(transportState.calls[0]?.body ?? '{}')).toMatchObject({ product, action });
  });

  it.each([
    { product: undefined },
    { product: '' },
    { product: ' \t ' },
    { product: null },
    { product: 42 },
    { product: [] },
    { action: undefined },
    { action: '' },
    { action: '\n ' },
    { action: null },
    { action: false },
    { action: {} },
    { params: null },
    { params: [] },
    { params: 'private-invalid-params' },
    { params: 42 },
    { params: true },
  ])(
    'SDK rejects invalid runtime input %j with INVALID_ARGUMENT/4 before HTTP',
    async (invalid) => {
      const { value, output } = await probeCall({
        product: 'FutureProduct',
        action: 'FutureAction',
        ...invalid,
      });
      expect(value.error).toMatchObject({ code: 'INVALID_ARGUMENT', exitCode: 4 });
      expect(output).not.toContain('private-invalid-params');
      expect(transportState.calls).toHaveLength(0);
    },
  );

  it.each([
    ['FutureProduct', 'FutureAction'],
    ['WebsitePortal', 'ListModelSeries'],
    ['OtherProduct', 'SearchHub'],
    ['websiteportal', 'SearchHub'],
    ['WebsitePortal', 'SearchAll'],
    ['aliyun-search-maas', 'SearchHub'],
    ['WebsitePortal', 'searchhub'],
    ['WebsitePortal ', 'SearchHub'],
  ])(
    'SDK treats unauthenticated %s/%s as private without expanding the anonymous pair list',
    async (product, action) => {
      credState.auth = null;
      const { value } = await probeCall({ product, action });
      expect(value.error).toMatchObject({ code: 'AUTH_REQUIRED', exitCode: 2 });
      expect(transportState.calls).toHaveLength(0);
    },
  );

  it.each([
    ['WebsitePortal', 'SearchHub'],
    ['FutureProduct', 'FutureAction'],
    ['aliyun-search-maas', 'SearchAll'],
  ])(
    'SDK does not downgrade expired credentials to anonymous access for %s/%s',
    async (product, action) => {
      credState.auth = 'expired';
      const { value } = await probeCall({ product, action });
      expect(value.error).toMatchObject({ code: 'TOKEN_EXPIRED', exitCode: 2 });
      expect(transportState.calls).toHaveLength(0);
    },
  );

  it('SDK keeps routing/auth fields in params as business parameters without overriding Type A top-level fields', async () => {
    const params = {
      product: 'Override',
      action: 'OverrideAction',
      region: 'other-region',
      authMode: 'none',
      url: 'https://override.test.qianwenai.com',
      headers: { marker: 'business-only' },
    };
    const { value } = await probeCall({ product: 'FutureProduct', action: 'FutureAction', params });
    expect(value.error).toBeUndefined();
    expect(transportState.calls).toHaveLength(1);
    expect(transportState.calls[0]?.authMode).toBe('required');
    expect(transportState.calls[0]?.url).toBe('https://api.test.qianwenai.com/data/v2/api.json');
    expect(transportState.calls[0]?.method).toBe('POST');
    expect(transportState.calls[0]?.headers).not.toHaveProperty('marker');
    expect(JSON.parse(transportState.calls[0]?.body ?? '{}')).toEqual({
      product: 'FutureProduct',
      action: 'FutureAction',
      region: 'cn-beijing',
      params: { ...params, headers: JSON.stringify(params.headers) },
    });
  });

  it('SDK preserves backend protocol rejection messages for unknown pairs without retrying', async () => {
    transportState.code = '403';
    const { value } = await probeCall({ product: 'FutureProduct', action: 'FutureAction' });
    expect(value.error).toMatchObject({ code: '403', message: 'backend admission denied' });
    expect(value.error.code).not.toMatch(/^(PLUGIN_)?API_FORBIDDEN$/);
    expect(transportState.calls).toHaveLength(1);
  });

  it('SDK preserves network error codes for unknown pairs without retrying', async () => {
    const { CliError } = await import('../../src/utils/errors.js');
    transportState.error = new CliError({
      code: 'NETWORK_ERROR',
      message: 'synthetic offline',
      exitCode: 3,
    });
    const { value } = await probeCall({ product: 'FutureProduct', action: 'FutureAction' });
    expect(value.error).toMatchObject({
      code: 'NETWORK_ERROR',
      exitCode: 3,
      message: 'synthetic offline',
    });
    expect(transportState.calls).toHaveLength(1);
  });

  it.each([
    ['WebsitePortal', 'SearchHub'],
    ['aliyun-search-maas', 'SearchAll'],
  ])(
    'SDK uses configured policies or built-in public access for %s/%s',
    async (product, action) => {
      credState.auth = null;
      const { value } = await probeCall({ product, action, params: { Query: 'demo' } });
      expect(value.error).toBeUndefined();
      expect(transportState.calls).toHaveLength(1);
      expect(transportState.calls[0]?.authMode).toBe('optional');
      expect(JSON.parse(transportState.calls[0]?.body ?? '{}')).toMatchObject({ product, action });
    },
  );

  it('SDK has no anonymous SearchHub permission without installed-plugin policy', async () => {
    policyState.rules = [];
    credState.auth = null;

    const { value } = await probeCall({ product: 'WebsitePortal', action: 'SearchHub' });

    expect(value.error).toMatchObject({ code: 'AUTH_REQUIRED', exitCode: 2 });
    expect(transportState.calls).toHaveLength(0);
  });

  it('SDK keeps authenticated SearchHub output raw without installed-plugin policy', async () => {
    policyState.rules = [];
    const data = { Success: false, Code: 'BUSINESS_VALUE', Data: { preserved: true } };
    transportState.data = data;

    const { value } = await probeCall({ product: 'WebsitePortal', action: 'SearchHub' });

    expect(value.error).toBeUndefined();
    expect(value.result).toEqual(data);
    expect(transportState.calls).toHaveLength(1);
    expect(transportState.calls[0].authMode).toBe('required');
  });

  it.each([
    { Success: true, Code: '200', Data: { items: [] } },
    { Success: false, Code: 'NOT_FOUND', Message: 'synthetic plugin data' },
  ])('preserves the plugin SDK raw Type A SearchHub response contract: %j', async (data) => {
    transportState.data = data;
    const pkgDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apiplugin');
    const program = new Command().exitOverride();
    const manifest: PluginManifest = {
      command: 'raw-search-plugin',
      entry: './entry.mjs',
      handlerKey: 'probeRawSearch',
    };
    registerPluginCommands(program, [{ name: 'raw-search-plugin', pkgDir, manifest }]);
    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += String(chunk);
      return true;
    });
    try {
      await program.parseAsync(['raw-search-plugin'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(captured)).toEqual(data);
    expect(transportState.calls).toHaveLength(1);
  });

  it('rejects a manifest entry that escapes the package via ../ before importing external code', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'apiplugin');
    const program = new Command();
    program.exitOverride();
    const manifest: PluginManifest = {
      command: 'evil',
      entry: '../../../../../../tmp/evil.mjs', // escapes pkgDir
      handlerKey: 'run',
    };
    registerPluginCommands(program, [{ name: 'evil', pkgDir, manifest }]);

    let captured = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: string) => {
      captured += c;
      return true;
    }) as typeof process.stderr.write);
    await program.parseAsync(['evil'], { from: 'user' }).catch(() => {});
    spy.mockRestore();

    expect(captured).toContain('escapes the package directory');
  });

  it.each([
    { state: null, entry: './anonymous.mjs', code: 'AUTH_REQUIRED' },
    { state: 'expired' as const, entry: './expired.mjs', code: 'TOKEN_EXPIRED' },
  ])(
    'auth:required rejects $code before importing the entry without handler output',
    async ({ state, entry, code }) => {
      credState.auth = state;
      const pkgDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'authrequired');
      const program = new Command().option('--format <fmt>', 'fmt').exitOverride();
      const manifest: PluginManifest = {
        command: 'authp',
        entry,
        handlerKey: 'run',
        auth: 'required',
      };
      registerPluginCommands(program, [{ name: 'authp', pkgDir, manifest }]);
      let stdout = '';
      let stderr = '';
      const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
      });
      const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      try {
        await program.parseAsync(['authp', '--format', 'json'], { from: 'user' }).catch(() => {});
        expect(JSON.parse(stderr)).toMatchObject({ error: { code, exit_code: 2 } });
        expect(stdout).toBe('');
        expect(stderr).not.toContain('synthetic-import-marker');
        expect(transportState.calls).toHaveLength(0);
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
    },
  );

  it('auth:required allows an authenticated user to execute the handler', async () => {
    credState.auth = 'valid'; // logged in
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command();
    program.exitOverride();
    const manifest: PluginManifest = {
      command: 'authp2',
      entry: './entry.mjs',
      handlerKey: 'echo',
      auth: 'required',
    };
    registerPluginCommands(program, [{ name: 'authp2', pkgDir, manifest }]);

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stdout.write);
    await program.parseAsync(['authp2'], { from: 'user' });
    spy.mockRestore();
    credState.auth = null; // restore default for other tests
    expect(captured).toMatch(/ctxKeys/);
  });

  it('auth:optional executes the handler without an authentication precheck when logged out', async () => {
    credState.auth = null; // logged out
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command();
    program.exitOverride();
    const manifest: PluginManifest = {
      command: 'optp',
      entry: './entry.mjs',
      handlerKey: 'echo',
      auth: 'optional',
    };
    registerPluginCommands(program, [{ name: 'optp', pkgDir, manifest }]);

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stdout.write);
    await program.parseAsync(['optp'], { from: 'user' });
    spy.mockRestore();
    expect(captured).toMatch(/ctxKeys/); // ran despite logged out
  });

  it('SDK forwards the plugin timeout AbortSignal to an in-flight request without retrying', async () => {
    const pkgDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apiplugin');
    const program = new Command().option('--format <fmt>', 'fmt').exitOverride();
    const manifest: PluginManifest = {
      command: 'waiting-api',
      entry: './entry.mjs',
      handlerKey: 'probeWaiting',
    };
    registerPluginCommands(program, [{ name: 'waiting-api', pkgDir, manifest }]);
    transportState.waitForAbort = true;
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
    try {
      const pending = program
        .parseAsync(['waiting-api', '--format', 'json'], { from: 'user' })
        .catch(() => {});
      await vi.waitFor(() => expect(transportState.calls).toHaveLength(1));
      const signal = transportState.calls[0]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(transportState.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      err.mockRestore();
    }
  });

  it('rejects a stalled async handler with PLUGIN_TIMEOUT without hanging the command', async () => {
    credState.auth = null;
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command().option('--format <fmt>', 'fmt');
    program.exitOverride();
    const manifest: PluginManifest = {
      command: 'hangp',
      entry: './entry.mjs',
      handlerKey: 'hang', // never-resolving handler
      auth: 'optional',
    };
    registerPluginCommands(program, [{ name: 'hangp', pkgDir, manifest }]);

    let captured = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stderr.write);

    vi.useFakeTimers();
    const run = program.parseAsync(['hangp', '--format', 'json'], { from: 'user' }).catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000); // fire the deadline timer → abort → reject
    await run;
    vi.useRealTimers();
    spy.mockRestore();
    expect(captured).toMatch(/PLUGIN_TIMEOUT/);
  });

  it('category: groups plugin commands in help by manifest.category', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command();
    const manifest: PluginManifest = {
      command: 'argp',
      entry: './entry.mjs',
      handlerKey: 'echo',
      category: 'Core',
    };
    registerPluginCommands(program, [{ name: 'argp', pkgDir, manifest }]);
    const stub = program.commands.find((c) => c.name() === 'argp');
    expect(getCommandHelpGroup(stub!)).toBe('Core');
  });

  it('category: defaults to the "Plugins" help group when category is absent', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command();
    const manifest: PluginManifest = { command: 'argp', entry: './entry.mjs', handlerKey: 'echo' };
    registerPluginCommands(program, [{ name: 'argp', pkgDir, manifest }]);
    const stub = program.commands.find((c) => c.name() === 'argp');
    expect(getCommandHelpGroup(stub!)).toBe('Plugins');
  });

  it('passes positional=[] to the handler after removing trailing Commander v14 options and Command', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command();
    program.exitOverride();
    const manifest: PluginManifest = { command: 'argp', entry: './entry.mjs', handlerKey: 'echo' };
    registerPluginCommands(program, [{ name: 'argp', pkgDir, manifest }]);

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
      captured += c;
      return true;
    }) as typeof process.stdout.write);
    await program.parseAsync(['argp'], { from: 'user' });
    spy.mockRestore();

    const result = JSON.parse(captured);
    expect(result.positional).toEqual([]);
    expect(result.optsCtor).toBe('Object');
    expect(result.ctxKeys).toEqual([
      'config',
      'directory',
      'abort',
      'callOpenApi',
      'format',
      'runtime',
      'errors',
      'terminal',
    ]);
  });

  it('passes inherited global --format to the handler through optsWithGlobals', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command().option('--format <fmt>', 'global format');
    program.exitOverride();
    const manifest: PluginManifest = { command: 'argp', entry: './entry.mjs', handlerKey: 'echo' };
    registerPluginCommands(program, [{ name: 'argp', pkgDir, manifest }]);

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
      captured += c;
      return true;
    }) as typeof process.stdout.write);
    await program.parseAsync(['argp', '--format', 'json'], { from: 'user' });
    spy.mockRestore();

    expect(JSON.parse(captured).opts.format).toBe('json');
  });

  it('provides effective ctx.config with at least the default output.format', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgDir = join(here, 'fixtures', 'argplugin');
    const program = new Command();
    program.exitOverride();
    const manifest: PluginManifest = { command: 'argp', entry: './entry.mjs', handlerKey: 'echo' };
    registerPluginCommands(program, [{ name: 'argp', pkgDir, manifest }]);

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
      captured += c;
      return true;
    }) as typeof process.stdout.write);
    await program.parseAsync(['argp'], { from: 'user' });
    spy.mockRestore();

    expect(JSON.parse(captured).configKeys.length).toBeGreaterThan(0);
  });
});

describe('loadInstalledPlugins — read the manifest, filter enabled entries, and assemble LoadablePlugin[]', () => {
  let root: string;
  let manifestPath: string;
  let pluginsDir: string;

  beforeEach(() => {
    root = createApiPolicyTestRoot('qianwen-plugin-load-');
    manifestPath = join(root, 'plugins.json');
    pluginsDir = join(root, 'plugins');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeInstalled(m: InstalledManifest): void {
    writeFileSync(manifestPath, JSON.stringify(m), 'utf8');
  }

  function writePkgManifest(name: string, manifest: PluginManifest): string {
    const pkgDir = join(pluginsDir, 'node_modules', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name, qianwen: manifest }),
      'utf8',
    );
    return pkgDir;
  }

  it('returns an empty array when the manifest is absent', () => {
    expect(loadInstalledPlugins(manifestPath, pluginsDir)).toEqual([]);
  });

  it('assembles an enabled LoadablePlugin with pkgDir set to <pluginsDir>/node_modules/<name>', () => {
    const expectedDir = writePkgManifest('demo', {
      command: 'demo',
      entry: './i.mjs',
      handlerKey: 'demo',
    });
    writeInstalled({ plugins: [{ name: 'demo', version: '1.0.0', enabled: true, source: 'npm' }] });

    const loadable = loadInstalledPlugins(manifestPath, pluginsDir);
    expect(loadable).toHaveLength(1);
    expect(loadable[0].name).toBe('demo');
    expect(loadable[0].pkgDir).toBe(expectedDir);
    expect(loadable[0].manifest.command).toBe('demo');
  });

  it('filters out enabled:false entries', () => {
    writePkgManifest('off', { command: 'off', entry: './i.mjs', handlerKey: 'off' });
    writeInstalled({ plugins: [{ name: 'off', version: '1.0.0', enabled: false, source: 'npm' }] });

    expect(loadInstalledPlugins(manifestPath, pluginsDir)).toEqual([]);
  });

  it('skips and warns about a missing package manifest without affecting other plugins', () => {
    const okDir = writePkgManifest('ok', { command: 'ok', entry: './i.mjs', handlerKey: 'ok' });
    writeInstalled({
      plugins: [
        { name: 'broken', version: '1.0.0', enabled: true, source: 'npm' },
        { name: 'ok', version: '1.0.0', enabled: true, source: 'npm' },
      ],
    });
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const loadable = loadInstalledPlugins(manifestPath, pluginsDir);

    expect(loadable).toHaveLength(1);
    expect(loadable[0].name).toBe('ok');
    expect(loadable[0].pkgDir).toBe(okDir);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/broken.*manifest/));
    spy.mockRestore();
  });

  it('uses an explicit entry path as pkgDir for linked or custom plugin paths', () => {
    const customDir = join(root, 'custom-loc');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      join(customDir, 'package.json'),
      JSON.stringify({
        name: 'linked',
        qianwen: { command: 'linked', entry: './i.mjs', handlerKey: 'linked' },
      }),
      'utf8',
    );
    writeInstalled({
      plugins: [
        { name: 'linked', version: '1.0.0', enabled: true, source: 'link', path: customDir },
      ],
    });

    const loadable = loadInstalledPlugins(manifestPath, pluginsDir);
    expect(loadable).toHaveLength(1);
    expect(loadable[0].pkgDir).toBe(customDir);
  });
});
