import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectTmpdir } from '../../fixtures/plugin-temporary-root.js';
import { runCommand, type RunResult } from '../../helpers/run-command.js';
import { registerPluginUpdateCommand } from '../../../src/commands/plugin/update.js';
import type { InstalledManifest } from '../../../src/plugins/manifest.js';

const state = vi.hoisted(() => ({
  root: '',
  fetch: vi.fn<typeof fetch>(),
  install: vi.fn(),
  writeManifest: vi.fn(),
}));

vi.mock('../../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../../src/config/paths.js')>()),
  getPluginsDir: () => join(state.root, 'plugins'),
  getPluginsManifestPath: () => join(state.root, 'plugins.json'),
}));
vi.mock('../../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../../src/plugins/npm-registry.js', () => ({
  resolveRegistryForPackage: () => ({
    registry: 'https://registry.test.qianwenai.com/',
    authToken: 'synthetic-registry-credential',
  }),
}));
vi.mock('../../../src/plugins/manifest.js', async (original) => ({
  ...(await original<typeof import('../../../src/plugins/manifest.js')>()),
  writeInstalledManifest: state.writeManifest,
}));
vi.mock('../../../src/plugins/installer.js', async (original) => {
  const actual = await original<typeof import('../../../src/plugins/installer.js')>();
  return {
    ...actual,
    installNpmPlugin: state.install,
    installLocalPlugin: state.install,
    getRegistryPluginMetadata: (
      name: string,
      options: Parameters<typeof actual.getRegistryPluginMetadata>[1],
    ) => actual.getRegistryPluginMetadata(name, { ...options, fetchImpl: state.fetch }),
  };
});

let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  state.root = mkdtempSync(join(projectTmpdir(), 'update-auth-'));
  mkdirSync(join(state.root, 'plugins'));
  state.fetch.mockReset().mockRejectedValue(new Error('unexpected synthetic request'));
  state.install.mockReset();
  state.writeManifest.mockReset();
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  vi.stubGlobal('fetch', state.fetch);
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(state.root, { recursive: true, force: true });
});

function save(plugins: InstalledManifest['plugins']): void {
  writeFileSync(join(state.root, 'plugins.json'), JSON.stringify({ plugins }));
}

function installed(name: string): InstalledManifest['plugins'][number] {
  return { name, version: '1.0.0', source: 'npm', enabled: true };
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function authResponse(status: number): Response {
  return new Response('synthetic-private-response-marker', {
    status,
    statusText: 'synthetic-private-status-marker',
  });
}

function healthyResponse(): Response {
  return new Response(
    JSON.stringify({
      'dist-tags': { latest: '1.1.0' },
      versions: {
        '1.1.0': {
          qianwen: { minCliVersion: '0.1.0' },
          dist: { tarball: 'https://registry.test.qianwenai.com/healthy/-/package.tgz' },
        },
      },
    }),
  );
}

function metadataResponse(version: string, minCliVersion: string): Response {
  return new Response(
    JSON.stringify({
      'dist-tags': { latest: version },
      versions: { [version]: { qianwen: { minCliVersion } } },
    }),
  );
}

async function invoke(args: string[]): Promise<RunResult> {
  const manifestBefore = readFileSync(join(state.root, 'plugins.json'), 'utf8');
  const writtenOutput: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writtenOutput.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  let result: RunResult;
  try {
    result = await runCommand(
      (program) => registerPluginUpdateCommand(program.command('plugin')),
      ['plugin', 'update', ...args],
    );
  } finally {
    write.mockRestore();
  }
  result.stdout += writtenOutput.join('');
  expect(readFileSync(join(state.root, 'plugins.json'), 'utf8')).toBe(manifestBefore);
  expect(readdirSync(join(state.root, 'plugins'))).toEqual([]);
  expect(readdirSync(state.root).sort()).toEqual(['plugins', 'plugins.json']);
  expect(state.install).not.toHaveBeenCalled();
  expect(state.writeManifest).not.toHaveBeenCalled();
  expect(
    state.fetch.mock.calls.every(([input]) => !requestUrl(input).pathname.includes('/-/')),
  ).toBe(true);
  expect(result.stdout + result.stderr).not.toMatch(
    /synthetic-registry-credential|synthetic-private-response-marker|synthetic-private-status-marker|\n\s+at\s/,
  );
  return result;
}

function authDiagnostic(result: RunResult): { error: { code: string; message: string } } {
  expect(result.exitCode ?? process.exitCode).toBe(2);
  const diagnostic = JSON.parse(result.stderr) as { error: { code: string; message: string } };
  expect(Object.keys(diagnostic)).toEqual(['error']);
  expect(diagnostic.error).toMatchObject({ code: 'PLUGIN_INSTALL_FAILED', exit_code: 2 });
  expect(diagnostic.error.message).toMatch(/auth|认证|鉴权|凭据|登录/i);
  return diagnostic;
}

function emptyAggregate(uncheckable: string[]) {
  return { updates: [], incompatible: [], invalidMetadata: [], uncheckable, unsupported: [] };
}

describe('plugin update registry authentication failures', () => {
  it('preserves one aggregate and a stable authentication code for named HTTP 401 and 403', async () => {
    save([installed('private'), installed('unselected')]);
    const codes: string[] = [];
    for (const status of [401, 403]) {
      state.fetch.mockReset().mockResolvedValue(authResponse(status));
      process.exitCode = 0;
      const result = await invoke(['private', '--format', 'json']);
      expect(JSON.parse(result.stdout)).toEqual(emptyAggregate(['private']));
      const diagnostic = authDiagnostic(result);
      expect(diagnostic.error.message).toContain(String(status));
      codes.push(diagnostic.error.code);
      expect(state.fetch).toHaveBeenCalledOnce();
      expect(requestUrl(state.fetch.mock.calls[0][0]).pathname).toBe('/private');
    }
    expect(codes[0]).toBe(codes[1]);
  });

  it('preserves healthy results and source classifications when one batch target needs authentication', async () => {
    save([
      installed('private'),
      installed('healthy'),
      installed('incompatible'),
      installed('invalid'),
      installed('unavailable'),
      { name: 'archive', version: '1.0.0', source: 'archive', enabled: true },
    ]);
    state.fetch.mockImplementation(async (input) => {
      switch (requestUrl(input).pathname) {
        case '/private':
          return authResponse(401);
        case '/healthy':
          return healthyResponse();
        case '/incompatible':
          return metadataResponse('2.0.0', '99.0.0');
        case '/invalid':
          return metadataResponse('3.0.0', 'invalid');
        case '/unavailable':
          return new Response('synthetic temporary outage', { status: 503 });
        default:
          throw new Error('unexpected synthetic request');
      }
    });
    const result = await invoke(['--format', 'json']);
    expect(JSON.parse(result.stdout)).toEqual({
      updates: [
        {
          name: 'healthy',
          current: '1.0.0',
          latest: '1.1.0',
          command: 'qianwen plugin install healthy@1.1.0',
        },
      ],
      incompatible: [{ name: 'incompatible', version: '2.0.0', minCliVersion: '99.0.0' }],
      invalidMetadata: [
        { name: 'invalid', version: '3.0.0', reason: 'invalid minCliVersion "invalid"' },
      ],
      uncheckable: ['private', 'unavailable'],
      unsupported: [{ name: 'archive', source: 'archive' }],
    });
    authDiagnostic(result);
    expect(state.fetch).toHaveBeenCalledTimes(5);
  });

  it('emits one deterministic authentication diagnostic regardless of rejection order', async () => {
    save([installed('first'), installed('second')]);
    const diagnostics: unknown[] = [];
    for (const order of [
      ['first', 'second'],
      ['second', 'first'],
    ]) {
      const pending = new Map<string, (response: Response) => void>();
      state.fetch.mockReset().mockImplementation(
        (input) =>
          new Promise<Response>((resolve) => {
            pending.set(requestUrl(input).pathname.slice(1), resolve);
          }),
      );
      process.exitCode = 0;
      const running = invoke(['--format', 'json']);
      await vi.waitFor(() => expect(pending.size).toBe(2));
      for (const name of order) {
        pending.get(name)!(authResponse(name === 'first' ? 401 : 403));
        await Promise.resolve();
      }
      const result = await running;
      expect(JSON.parse(result.stdout)).toEqual(emptyAggregate(['first', 'second']));
      const diagnostic = authDiagnostic(result);
      expect(diagnostic.error.message).toContain('401');
      expect(diagnostic.error.message).toContain('403');
      diagnostics.push(diagnostic);
      expect(state.fetch).toHaveBeenCalledTimes(2);
    }
    expect(diagnostics[0]).toEqual(diagnostics[1]);
  });

  it.each([
    { format: 'text', status: 401 },
    { format: 'text', status: 403 },
    { format: 'table', status: 401 },
    { format: 'table', status: 403 },
  ])(
    'keeps update advice and reports HTTP $status authentication in $format',
    async ({ format, status }) => {
      save([installed('private'), installed('healthy')]);
      state.fetch.mockImplementation(async (input) =>
        requestUrl(input).pathname === '/private' ? authResponse(status) : healthyResponse(),
      );
      const result = await invoke(['--format', format]);
      expect(result.exitCode ?? process.exitCode).toBe(2);
      expect(result.stdout).toContain('healthy');
      expect(result.stdout).toContain('1.1.0');
      expect(result.stderr).toMatch(/auth|认证|鉴权|凭据|登录/i);
      expect(result.stderr.match(/Error:/g)).toHaveLength(1);
      expect(result.stderr).toContain(String(status));
      expect(result.stdout + result.stderr).not.toMatch(/registry unreachable|registry.*不可达/i);
      expect(state.fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps ordinary failed checks and unsupported sources successful without authentication diagnostics', async () => {
    save([
      installed('missing'),
      installed('unavailable'),
      installed('disconnected'),
      { name: 'linked', version: '1.0.0', source: 'link', enabled: true },
    ]);
    state.fetch.mockImplementation(async (input) => {
      const name = requestUrl(input).pathname;
      if (name === '/disconnected') throw new TypeError('synthetic connection failure');
      return new Response('synthetic registry failure', {
        status: name === '/missing' ? 404 : 503,
      });
    });
    const result = await invoke(['--format', 'json']);
    expect(result.exitCode ?? process.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      ...emptyAggregate(['missing', 'unavailable', 'disconnected']),
      unsupported: [{ name: 'linked', source: 'link' }],
    });
    expect(state.fetch).toHaveBeenCalledTimes(3);
  });
});
