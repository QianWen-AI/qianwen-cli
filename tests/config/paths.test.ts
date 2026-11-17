import { describe, it, expect, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  getConfigDir,
  getPluginsDir,
  getPluginsManifestPath,
  getCredentialsPath,
  getGlobalConfigPath,
  getCacheDir,
  getCacheFilePath,
  getMigrationStatePath,
  getDeviceFlowPendingPath,
  getLocalConfigPath,
} from '../../src/config/paths.js';

describe('getPluginsDir', () => {
  it('returns the plugins subdirectory under configDir', () => {
    expect(getPluginsDir()).toBe(join(getConfigDir(), 'plugins'));
  });
});

describe('getPluginsManifestPath', () => {
  it('returns plugins.json under configDir, beside pluginsDir', () => {
    expect(getPluginsManifestPath()).toBe(join(getConfigDir(), 'plugins.json'));
  });

  it('keeps the manifest outside pluginsDir and separate from plugin files', () => {
    expect(getPluginsManifestPath().startsWith(getPluginsDir() + '/')).toBe(false);
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('isolated CLI configuration directory', () => {
  it.each([undefined, '', '   '])(
    'preserves the existing home directory default for %j',
    (value) => {
      vi.stubEnv('QIANWEN_CONFIG_DIR', value);
      expect(getConfigDir()).toBe(join(homedir(), '.qianwen'));
    },
  );

  it('isolates credentials, config, cache and plugin state under an explicit directory', () => {
    const directory = resolve('preview-state');
    vi.stubEnv('QIANWEN_CONFIG_DIR', ` ${directory} `);
    expect(getConfigDir()).toBe(directory);
    expect(getCredentialsPath()).toBe(join(directory, 'credentials'));
    expect(getGlobalConfigPath()).toBe(join(directory, 'config.json'));
    expect(getCacheDir()).toBe(join(directory, 'cache'));
    expect(getCacheFilePath('models.json')).toBe(join(directory, 'cache', 'models.json'));
    expect(getPluginsDir()).toBe(join(directory, 'plugins'));
    expect(getPluginsManifestPath()).toBe(join(directory, 'plugins.json'));
    expect(getMigrationStatePath()).toBe(join(directory, '.migrated-projects'));
    expect(getDeviceFlowPendingPath()).toBe(join(directory, '.device-flow-pending'));
  });

  it('resolves a relative override while retaining the caller-selected project config location', () => {
    vi.stubEnv('QIANWEN_CONFIG_DIR', './preview-state');
    expect(getConfigDir()).toBe(resolve('preview-state'));
    expect(getLocalConfigPath('/tmp/plugin-work')).toBe(
      resolve('/tmp/plugin-work', '.qianwen.json'),
    );
  });
});
