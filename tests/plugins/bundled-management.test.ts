import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import { pluginListAction } from '../../src/commands/plugin/list.js';
import { pluginInstallAction } from '../../src/commands/plugin/install.js';
import { pluginUpdateAction } from '../../src/commands/plugin/update.js';
import { pluginUninstallAction } from '../../src/commands/plugin/uninstall.js';
import { readInstalledManifest, validateManifest } from '../../src/plugins/manifest.js';

const state = vi.hoisted(() => ({
  root: '',
  definitions: [] as DefaultPlugin[],
  npmInstall: vi.fn(),
  registry: vi.fn(),
}));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => state.definitions,
  getDefaultPlugin: (name: string) =>
    state.definitions.find((definition) => definition.name === name),
}));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getPluginsDir: () => path.join(state.root, 'plugins'),
  getPluginsManifestPath: () => path.join(state.root, 'plugins.json'),
}));
vi.mock('../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({ 'output.format': 'json' }),
}));
vi.mock('../../src/plugins/installer.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/installer.js')>()),
  installNpmPlugin: state.npmInstall,
  getRegistryPluginMetadata: state.registry,
}));
import { installLocalPlugin } from '../../src/plugins/installer.js';

const name = '@qianwenai/default-test';
const manifest = { command: 'catalog', entry: './index.js', handlerKey: 'search' };

function writePackage(directory: string, version: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version, qianwen: manifest }),
  );
  writeFileSync(path.join(directory, 'index.js'), 'export const handlers = { search() {} };');
}

beforeEach(() => {
  vi.clearAllMocks();
  const temporaryRoot = path.resolve(__dirname, '../../.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  state.root = mkdtempSync(path.join(temporaryRoot, 'default-management-'));
  state.definitions.splice(0, state.definitions.length, {
    name,
    version: '1.2.3',
    source: { type: 'npm' },
    command: manifest.command,
  });
  writePackage(path.join(state.root, 'plugins', 'node_modules', name), '3.0.0');
  writeFileSync(
    path.join(state.root, 'plugins.json'),
    JSON.stringify({
      plugins: [{ name, version: '3.0.0', enabled: true, source: 'npm', command: 'catalog' }],
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Network is forbidden in this test');
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(state.root, { recursive: true, force: true });
});

describe('independent management of default plugins', () => {
  it('lists the installed user version separately from its default bootstrap version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const command = new Command();
    await pluginListAction(command).call(command);
    const payload = JSON.parse(log.mock.calls[0][0] as string);
    expect(payload.plugins).toHaveLength(1);
    expect(payload.plugins[0]).toMatchObject({
      name,
      version: '3.0.0',
      defaultVersion: '1.2.3',
      enabled: true,
      source: 'npm',
      origin: 'default',
      status: 'installed',
    });
    expect(state.npmInstall).not.toHaveBeenCalled();
  });

  it('allows explicit upgrade of a default through the ordinary install command', async () => {
    const source = path.join(state.root, 'candidate');
    writePackage(source, '4.0.0');
    state.npmInstall.mockImplementation(async (_spec: string, pluginsDir: string) =>
      installLocalPlugin(source, pluginsDir),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const command = new Command();

    await pluginInstallAction(command).call(command, name + '@4.0.0');

    expect(state.npmInstall).toHaveBeenCalledOnce();
    expect(readInstalledManifest(path.join(state.root, 'plugins.json')).plugins[0].version).toBe(
      '4.0.0',
    );
  });

  it.each([name, undefined])(
    'checks updates for default npm plugins with target %s without auto-installing',
    async (target) => {
      state.registry.mockResolvedValue({ latest: '4.0.0', versions: { '4.0.0': {} } });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const command = new Command();

      await pluginUpdateAction(command).call(command, target);

      expect(state.registry).toHaveBeenCalledOnce();
      expect(JSON.parse(log.mock.calls[0][0] as string).updates[0]).toMatchObject({
        name,
        current: '3.0.0',
        latest: '4.0.0',
      });
      expect(state.npmInstall).not.toHaveBeenCalled();
      expect(readInstalledManifest(path.join(state.root, 'plugins.json')).plugins[0].version).toBe(
        '3.0.0',
      );
    },
  );

  it('allows uninstall and persists suppression of the default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const command = new Command();

    await pluginUninstallAction(command).call(command, name);

    const installed = JSON.parse(readFileSync(path.join(state.root, 'plugins.json'), 'utf8'));
    expect(installed).toMatchObject({ plugins: [], disabledDefaults: [name] });
    expect(state.npmInstall).not.toHaveBeenCalled();
    expect(state.registry).not.toHaveBeenCalled();
  });
});

describe('plugin presentation and execution metadata', () => {
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 1_800_001 },
    { timeoutMs: 1.2 },
    { helpOrder: NaN },
    { examples: 'wrong' },
    { longDescription: 42 },
  ])('rejects invalid extension values: %j', (extension) => {
    expect(
      validateManifest({ ...manifest, ...extension } as Parameters<typeof validateManifest>[0]),
    ).toEqual(expect.any(String));
  });
});
