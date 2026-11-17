import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectTmpdir } from '../../fixtures/plugin-temporary-root.js';
import { runCommand } from '../../helpers/run-command.js';
import { registerPluginUpdateCommand } from '../../../src/commands/plugin/update.js';
import { writeInstalledManifest, type InstalledManifest } from '../../../src/plugins/manifest.js';

const state = vi.hoisted(() => ({ root: '', metadata: vi.fn() }));
vi.mock('../../../src/config/paths.js', () => ({
  getPluginsManifestPath: () => join(state.root, 'plugins.json'),
}));
vi.mock('../../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../../src/plugins/installer.js', () => ({ getRegistryPluginMetadata: state.metadata }));
beforeEach(() => {
  state.root = mkdtempSync(join(projectTmpdir(), 'update-sources-'));
  state.metadata.mockReset().mockRejectedValue(new Error('synthetic registry unavailable'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(state.root, { recursive: true, force: true });
});
function save(plugins: InstalledManifest['plugins']): void {
  writeInstalledManifest(join(state.root, 'plugins.json'), { plugins });
}
function invoke(args: string[]) {
  return runCommand(
    (program) => {
      registerPluginUpdateCommand(program.command('plugin'));
    },
    ['plugin', 'update', ...args],
  );
}
describe('registry update source reporting', () => {
  it('preserves an available registry update alongside unsupported sources', async () => {
    state.metadata.mockResolvedValue({ latest: '1.1.0', versions: { '1.1.0': {} } });
    save([
      { name: 'registry', version: '1.0.0', source: 'npm', enabled: true },
      { name: 'fixture', version: '1.0.0', source: 'archive', enabled: true },
    ]);
    const result = await invoke(['--format', 'json']);
    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({
      updates: [
        {
          name: 'registry',
          current: '1.0.0',
          latest: '1.1.0',
          command: 'qianwen plugin install registry@1.1.0',
        },
      ],
      incompatible: [],
      invalidMetadata: [],
      uncheckable: [],
      unsupported: [{ name: 'fixture', source: 'archive' }],
    });
    expect(state.metadata).toHaveBeenCalledExactlyOnceWith('registry', {
      downloadTimeoutMs: 30_000,
    });
  });
  it.each(['text', 'table'])('explains a named unsupported target in %s', async (format) => {
    save([
      { name: 'fixture', version: '1.0.0', source: 'link', enabled: true },
      { name: 'registry', version: '1.0.0', source: 'npm', enabled: true },
    ]);
    const result = await invoke(['fixture', '--format', format]);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout + result.stderr).toMatch(/fixture/);
    expect(result.stdout + result.stderr).toMatch(/link/);
    expect(result.stdout + result.stderr).toMatch(
      /不支持|无法.*检查|unsupported|not support|cannot.*check|not.*check/i,
    );
    expect(result.stdout + result.stderr).not.toMatch(
      /均为最新|全部.*最新|所有.*最新|all.*latest|all.*up.to.date/i,
    );
    expect(state.metadata).not.toHaveBeenCalled();
  });
  it.each(['local', 'archive', 'link', 'bundle'] as const)(
    'reports a named %s source without fetching registry data',
    async (source) => {
      save([{ name: 'fixture', version: '1.0.0', source, enabled: true }]);
      const result = await invoke(['fixture', '--format', 'json']);
      expect(result.exitCode).toBeUndefined();
      expect(JSON.parse(result.stdout)).toEqual({
        updates: [],
        incompatible: [],
        invalidMetadata: [],
        uncheckable: [],
        unsupported: [{ name: 'fixture', source }],
      });
      expect(state.metadata).not.toHaveBeenCalled();
    },
  );
  it.each(['text', 'table'])(
    'explains unsupported sources in %s without claiming all latest',
    async (format) => {
      save([{ name: 'fixture', version: '1.0.0', source: 'archive', enabled: true }]);
      const result = await invoke(['--format', format]);
      expect(result.stdout + result.stderr).toMatch(/fixture/);
      expect(result.stdout + result.stderr).toMatch(/archive/);
      expect(result.stdout + result.stderr).toMatch(
        /不支持|无法.*检查|unsupported|not support|cannot.*check|not.*check/i,
      );
      expect(result.stdout + result.stderr).not.toMatch(
        /均为最新|全部.*最新|所有.*最新|all.*latest|all.*up.to.date/i,
      );
      expect(state.metadata).not.toHaveBeenCalled();
    },
  );
  it('keeps registry failures separate from unsupported aggregate targets', async () => {
    save([
      { name: 'registry', version: '1.0.0', source: 'npm', enabled: true },
      { name: 'local', version: '1.0.0', source: 'local', enabled: true },
      { name: 'linked', version: '1.0.0', source: 'link', enabled: true },
    ]);
    const result = await invoke(['--format', 'json']);
    expect(JSON.parse(result.stdout)).toEqual({
      updates: [],
      incompatible: [],
      invalidMetadata: [],
      uncheckable: ['registry'],
      unsupported: [
        { name: 'local', source: 'local' },
        { name: 'linked', source: 'link' },
      ],
    });
    expect(state.metadata).toHaveBeenCalledExactlyOnceWith('registry', {
      downloadTimeoutMs: 30_000,
    });
  });
});
