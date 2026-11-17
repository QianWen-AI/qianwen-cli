import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import { HandledError } from '../../src/utils/errors.js';
import { initializeDefaultPlugins } from '../../src/plugins/initialize.js';

const state = vi.hoisted(() => ({
  defaults: [] as DefaultPlugin[],
  disabled: [] as string[],
  ensure: vi.fn(),
}));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => state.defaults,
  getDefaultPlugin: (name: string) => state.defaults.find((plugin) => plugin.name === name),
}));
vi.mock('../../src/plugins/default-install.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/default-install.js')>()),
  ensureDefaultPlugin: state.ensure,
  recoverManagedPluginInstalls: vi.fn(async () => {}),
}));
vi.mock('../../src/plugins/manifest.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/manifest.js')>()),
  readInstalledManifest: () => ({ plugins: [], disabledDefaults: state.disabled }),
}));

function definition(name: string, command: string): DefaultPlugin {
  return {
    name,
    version: '1.2.3',
    command,
    source: { type: 'npm' },
  };
}

function command(): Command {
  return new Command('qianwen');
}

beforeEach(() => {
  state.defaults.splice(
    0,
    state.defaults.length,
    definition('@qianwenai/catalog-default', 'catalog'),
    definition('@qianwenai/lookup-default', 'lookup'),
  );
  state.disabled.splice(0);
  state.ensure.mockReset().mockImplementation(async (plugin: DefaultPlugin) => ({
    name: plugin.name,
    version: plugin.version,
    source: 'npm',
    enabled: true,
  }));
});

afterEach(() => vi.restoreAllMocks());

describe('internal default plugin initialization', () => {
  it('prepares every default and reports each resulting version as JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cmd = command();

    await initializeDefaultPlugins(cmd);

    expect(
      state.ensure.mock.calls.map(([plugin]) => (plugin as DefaultPlugin).name).sort(),
    ).toEqual(state.defaults.map((plugin) => plugin.name).sort());
    const payload = JSON.parse(log.mock.calls[0][0] as string) as { plugins: unknown[] };
    expect(payload.plugins).toEqual(
      state.defaults.map((plugin) => ({
        name: plugin.name,
        status: 'installed',
        version: '1.2.3',
      })),
    );
  });

  it('reports explicitly disabled defaults and does not reinstall them', async () => {
    state.disabled.push(state.defaults[0].name);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cmd = command();

    await initializeDefaultPlugins(cmd);

    expect(state.ensure.mock.calls.map(([plugin]) => (plugin as DefaultPlugin).name)).toEqual([
      state.defaults[1].name,
    ]);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      plugins: [
        { name: state.defaults[0].name, status: 'disabled' },
        { name: state.defaults[1].name, status: 'installed', version: '1.2.3' },
      ],
    });
  });

  it('reports partial results and exits nonzero after any default fails', async () => {
    state.ensure.mockImplementation(async (plugin: DefaultPlugin) => {
      if (plugin.name === state.defaults[0].name) throw new Error('Fixture download failed');
      return { name: plugin.name, version: '1.2.3', source: 'npm', enabled: true };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cmd = command();

    const execution = initializeDefaultPlugins(cmd);
    await expect(execution).rejects.toBeInstanceOf(HandledError);
    await expect(execution).rejects.toMatchObject({ exitCode: 4 });

    expect(state.ensure).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      plugins: [
        {
          name: state.defaults[0].name,
          status: 'failed',
          error: 'Fixture download failed',
          code: 'PLUGIN_PREPARE_FAILED',
        },
        { name: state.defaults[1].name, status: 'installed', version: '1.2.3' },
      ],
    });
    const diagnostic = stderr.mock.calls.map(([value]) => value).join('');
    expect(diagnostic).toContain('PLUGIN_PREPARE_FAILED');
    expect(diagnostic).not.toContain('plugin prepare');
  });
});
