import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand } from '../../helpers/run-command.js';
import { CliError } from '../../../src/utils/errors.js';

const state = vi.hoisted(() => ({
  root: '',
  legacyFailure: false,
  structuredFailure: null as CliError | null,
  fetch: vi.fn(),
}));
vi.mock('../../../src/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/config/paths.js')>()),
  getPluginsDir: () => path.join(state.root, 'plugins'),
  getPluginsManifestPath: () => path.join(state.root, 'plugins.json'),
}));
vi.mock('../../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../../src/plugins/npm-registry.js', async (original) => ({
  ...(await original<typeof import('../../../src/plugins/npm-registry.js')>()),
  resolveRegistryForPackage: () => ({ registry: 'https://registry.test.qianwenai.com/' }),
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: vi.fn(async () => {}),
  renderWithInkSync: vi.fn(async () => {}),
  renderInteractive: vi.fn(async () => {}),
}));
vi.mock('../../../src/plugins/installer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/plugins/installer.js')>();
  return {
    ...actual,
    installNpmPlugin: (spec: string, dir: string) =>
      state.structuredFailure
        ? Promise.resolve({
            ok: false,
            error: state.structuredFailure.message,
            cliError: state.structuredFailure,
          })
        : state.legacyFailure
          ? Promise.resolve({ ok: false, error: 'mock legacy install failure' })
          : actual.installNpmPlugin(spec, dir, {
              fetchImpl: state.fetch as unknown as typeof fetch,
            }),
  };
});

import { installNpmPlugin } from '../../../src/plugins/installer.js';
import { registerPluginManagementCommands } from '../../../src/commands/plugin/index.js';

let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  state.root = mkdtempSync(path.join(tmpdir(), 'qianwen-plugin-install-'));
  mkdirSync(path.join(state.root, 'plugins'));
  writeFileSync(path.join(state.root, 'plugins.json'), JSON.stringify({ plugins: [] }));
  state.legacyFailure = false;
  state.structuredFailure = null;
  state.fetch.mockReset().mockRejectedValue(new TypeError('mock connection unavailable'));
  originalExitCode = process.exitCode;
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  rmSync(state.root, { recursive: true, force: true });
});

describe('install keeps structured failures', () => {
  it.each([401, 403])(
    'registry HTTP %s is an authentication failure with exit 2',
    async (status) => {
      state.fetch.mockResolvedValue(new Response('authentication required', { status }));
      const result = await runCommand(registerPluginManagementCommands, [
        'plugin',
        'install',
        '@qianwenai/install-network-fixture',
        '--format',
        'json',
      ]);
      expect(result.exitCode ?? process.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(readFileSync(path.join(state.root, 'plugins.json'), 'utf8')).toBe(
        JSON.stringify({ plugins: [] }),
      );
    },
  );

  it('real installer retains CliError code/exitCode after fetch rejection and keeps legacy text', async () => {
    const result = await installNpmPlugin(
      '@qianwenai/install-network-fixture',
      path.join(state.root, 'plugins'),
    );

    expect(state.fetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      error: expect.any(String),
      cliError: { code: 'PLUGIN_INSTALL_FAILED', exitCode: 3 },
    });
    expect(result).toHaveProperty('cliError', expect.any(CliError));
  });

  it.each(['json', 'text', 'table'])(
    'network failure in %s format exits 3 without a stack',
    async (format) => {
      const result = await runCommand(registerPluginManagementCommands, [
        'plugin',
        'install',
        '@qianwenai/install-network-fixture',
        '--format',
        format,
      ]);

      expect(state.fetch).toHaveBeenCalledOnce();
      expect(result.exitCode ?? process.exitCode).toBe(3);
      expect(result.stderr).toMatch(/network|connection/i);
      expect(result.stderr).not.toMatch(/\n\s+at\s/);
      expect(result.stdout).toBe('');
      if (format === 'json')
        expect(JSON.parse(result.stderr).error.code).toBe('PLUGIN_INSTALL_FAILED');
      expect(
        JSON.parse(readFileSync(path.join(state.root, 'plugins.json'), 'utf8')).plugins,
      ).toEqual([]);
    },
  );

  it.each(['json', 'text', 'table'])(
    'a structured error in %s preserves its original non-network exit code',
    async (format) => {
      state.structuredFailure = new CliError({
        code: 'MOCK_REGISTRY_CONFIG_ERROR',
        message: 'mock registry configuration invalid',
        exitCode: 4,
      });
      state.structuredFailure.cause = new Error('mock-private-cause-must-not-appear');
      const result = await runCommand(registerPluginManagementCommands, [
        'plugin',
        'install',
        '@qianwenai/install-network-fixture',
        '--format',
        format,
      ]);
      expect(result.exitCode ?? process.exitCode).toBe(4);
      if (format === 'json')
        expect(JSON.parse(result.stderr).error.code).toBe('MOCK_REGISTRY_CONFIG_ERROR');
      expect(result.stderr).toContain('mock registry configuration invalid');
      expect(result.stderr).not.toMatch(/\n\s+at\s/);
      expect(result.stderr).not.toContain('mock-private-cause-must-not-appear');
      expect(result.stdout).toBe('');
      expect(state.fetch).not.toHaveBeenCalled();
    },
  );

  it('string-only install failure preserves ordinary failure behavior', async () => {
    state.legacyFailure = true;
    const result = await runCommand(registerPluginManagementCommands, [
      'plugin',
      'install',
      '@qianwenai/install-network-fixture',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('mock legacy install failure');
    expect(state.fetch).not.toHaveBeenCalled();
  });
});
