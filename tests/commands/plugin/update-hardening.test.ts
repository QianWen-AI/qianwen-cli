import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { pluginUpdateAction } from '../../../src/commands/plugin/update.js';
import { getRegistryPluginMetadata } from '../../../src/plugins/installer.js';
import { outputJSON } from '../../../src/output/format.js';

vi.mock('../../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../../src/config/paths.js', () => ({ getPluginsManifestPath: () => 'unused' }));
vi.mock('../../../src/plugins/manifest.js', () => ({
  readInstalledManifest: () => ({
    plugins: ['one', 'two', 'three'].map((name) => ({
      name,
      version: '1.0.0',
      source: 'npm',
      enabled: true,
    })),
  }),
}));
vi.mock('../../../src/plugins/installer.js', () => ({ getRegistryPluginMetadata: vi.fn() }));
vi.mock('../../../src/output/format.js', () => ({
  resolveFormatFromCommand: () => 'json',
  outputJSON: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('starts all checks concurrently and bounds stalled metadata to one deadline', async () => {
  vi.useFakeTimers();
  vi.mocked(getRegistryPluginMetadata).mockImplementation(() => new Promise(() => {}));
  const program = new Command();
  const run = pluginUpdateAction(program).call(program, undefined);
  expect(getRegistryPluginMetadata).toHaveBeenCalledTimes(3);
  expect(getRegistryPluginMetadata).toHaveBeenCalledWith('one', { downloadTimeoutMs: 30_000 });
  await vi.advanceTimersByTimeAsync(30_000);
  await run;
  expect(outputJSON).toHaveBeenCalledWith({
    updates: [],
    incompatible: [],
    invalidMetadata: [],
    uncheckable: ['one', 'two', 'three'],
    unsupported: [],
  });
  expect(vi.getTimerCount()).toBe(0);
});
