import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { site } from '../../src/site.js';

const s = {
  ...site,
  ...site.features,
  currencySymbol: site.features.currency === 'CNY' ? '¥' : '$',
};

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock paths module to return predictable paths
vi.mock('../../src/config/paths.js', () => ({
  getGlobalConfigPath: () => '/mock/home/.qianwen/config.json',
  getLocalConfigPath: () => '/mock/cwd/.qianwen.json',
  getMigrationStatePath: () => '/mock/home/.qianwen/.migrated-projects',
  getConfigDir: () => '/mock/home/.qianwen',
}));

const GLOBAL_PATH = '/mock/home/.qianwen/config.json';
const LEGACY_PATH = '/mock/cwd/.qianwen.json';
const MIGRATION_STATE_PATH = '/mock/home/.qianwen/.migrated-projects';

const mockedFs = vi.mocked(fs);

/**
 * Reload the manager module so its module-level migration guard resets.
 * Each test that exercises migration behaviour gets a fresh instance.
 */
async function loadManager() {
  vi.resetModules();
  return await import('../../src/config/manager.js');
}

describe('readGlobalConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty object when file does not exist', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { readGlobalConfig } = await loadManager();

    const result = readGlobalConfig();

    expect(result).toEqual({});
    expect(mockedFs.readFileSync).not.toHaveBeenCalled();
  });

  it('parses valid global config and converts to dot notation', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        output: { format: 'json' },
        api: { endpoint: 'https://custom.api.com' },
      }),
    );
    const { readGlobalConfig } = await loadManager();

    const result = readGlobalConfig();

    expect(result).toEqual({
      'output.format': 'json',
      'api.endpoint': 'https://custom.api.com',
    });
  });

  it('returns empty object on invalid JSON', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('not valid json');
    const { readGlobalConfig } = await loadManager();

    expect(readGlobalConfig()).toEqual({});
  });

  it('reads only known schema keys and rejects unknown top-level, nested and dotted keys', async () => {
    mockedFs.existsSync.mockImplementation((path) => path === GLOBAL_PATH);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        output: { format: 'json', future: 'mock-value' },
        model: { endpoint: 'https://model.test.qianwenai.com', api_key: 'mock-model-key' },
        auth: { endpoint: 'https://auth.test.qianwenai.com', token: 'mock-auth-token' },
        secret: 'mock-root-value',
        'future.credential': 'mock-dot-value',
      }),
    );
    const { readGlobalConfig, getEffectiveConfig } = await loadManager();
    const global = readGlobalConfig();
    expect(global).toEqual({
      'output.format': 'json',
      'model.endpoint': 'https://model.test.qianwenai.com',
      'model.api_key': 'mock-model-key',
      'auth.endpoint': 'https://auth.test.qianwenai.com',
    });
    const effective = getEffectiveConfig();
    expect(Object.keys(effective).sort()).toEqual([
      'api.endpoint',
      'auth.endpoint',
      'cache.ttl',
      'model.api_key',
      'model.endpoint',
      'output.format',
      'support.categorySource',
    ]);
    expect(effective['model.api_key']).toBe('mock-model-key');
  });

  it('returns empty object on read error', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });
    const { readGlobalConfig } = await loadManager();

    expect(readGlobalConfig()).toEqual({});
  });
});

describe('getEffectiveConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns defaults when no config file exists', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { getEffectiveConfig } = await loadManager();

    const result = getEffectiveConfig();

    expect(result['output.format']).toBe('auto');
    expect(result['api.endpoint']).toBe(s.apiEndpoint);
    expect(result['auth.endpoint']).toBe(s.authEndpoint);
  });

  it('merges global config over defaults', async () => {
    mockedFs.existsSync.mockImplementation((path) => path === GLOBAL_PATH);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ output: { format: 'table' } }));
    const { getEffectiveConfig } = await loadManager();

    const result = getEffectiveConfig();

    expect(result['output.format']).toBe('table');
    expect(result['api.endpoint']).toBe(s.apiEndpoint); // default
  });

  it('does not merge nested fields outside the schema from global configuration', async () => {
    mockedFs.existsSync.mockImplementation((path) => path === GLOBAL_PATH);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        output: { format: 'text' },
        auth: { token: 'mock-only' },
        future: { option: 'mock-only' },
      }),
    );
    const { getEffectiveConfig } = await loadManager();
    const result = getEffectiveConfig();
    expect(result['output.format']).toBe('text');
    expect(result).not.toHaveProperty('auth.token');
    expect(result).not.toHaveProperty('future.option');
  });
});

describe('getConfigValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(false);
  });

  it('returns default value when no config set', async () => {
    const { getConfigValue } = await loadManager();
    expect(getConfigValue('output.format')).toBe('auto');
  });

  it('returns overridden value from global config', async () => {
    mockedFs.existsSync.mockImplementation((path) => path === GLOBAL_PATH);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ output: { format: 'text' } }));
    const { getConfigValue } = await loadManager();

    expect(getConfigValue('output.format')).toBe('text');
  });
});

describe('setConfigValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to the global config file', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({}));
    const { setConfigValue } = await loadManager();

    setConfigValue('output.format', 'json');

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      GLOBAL_PATH,
      expect.stringContaining('"format": "json"'),
    );
  });

  it('creates the global config directory if missing', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { setConfigValue } = await loadManager();

    setConfigValue('output.format', 'table');

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/mock/home/.qianwen', { recursive: true });
  });

  it('rejects invalid values without writing', async () => {
    const { setConfigValue } = await loadManager();

    expect(() => setConfigValue('output.format', 'bogus')).toThrow();
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('unsetConfigValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes the key from the global config file', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ output: { format: 'json' } }));
    const { unsetConfigValue } = await loadManager();

    unsetConfigValue('output.format');

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      GLOBAL_PATH,
      expect.not.stringContaining('format'),
    );
  });

  it('does nothing when the global config file does not exist', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { unsetConfigValue } = await loadManager();

    unsetConfigValue('output.format');

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('getConfigEntries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(false);
  });

  it('returns all keys with default source when no config exists', async () => {
    const { getConfigEntries } = await loadManager();
    const entries = getConfigEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('output.format');
    expect(entries[0].value).toBe('auto');
    expect(entries[0].source).toBe('default');
  });

  it('shows global source when global config exists', async () => {
    mockedFs.existsSync.mockImplementation((path) => path === GLOBAL_PATH);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ output: { format: 'json' } }));
    const { getConfigEntries } = await loadManager();

    const entries = getConfigEntries();
    const formatEntry = entries.find((e) => e.key === 'output.format');
    expect(formatEntry?.source).toBe('global');
    expect(formatEntry?.value).toBe('json');
    expect(formatEntry?.sourcePath).toBe(`~/${s.configDirName}/config.json`);
  });
});

describe('legacy project-config migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges legacy keys into global and records the cwd path', async () => {
    // Legacy file exists, global file and migration-state file do not.
    mockedFs.existsSync.mockImplementation((path) => {
      if (path === LEGACY_PATH) return true;
      if (path === '/mock/home/.qianwen') return true; // dir exists, no mkdir
      return false;
    });
    mockedFs.readFileSync.mockImplementation((path) => {
      if (path === LEGACY_PATH) return JSON.stringify({ output: { format: 'json' } });
      throw new Error(`unexpected read: ${String(path)}`);
    });

    const { getEffectiveConfig } = await loadManager();
    getEffectiveConfig();

    // The merged value was written to the global file.
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      GLOBAL_PATH,
      expect.stringContaining('"format": "json"'),
    );
    // The legacy path was appended to the migration-state file.
    expect(mockedFs.appendFileSync).toHaveBeenCalledWith(MIGRATION_STATE_PATH, `${LEGACY_PATH}\n`);
  });

  it('skips migration when the cwd path is already recorded', async () => {
    mockedFs.existsSync.mockImplementation((path) => {
      if (path === LEGACY_PATH) return true;
      if (path === MIGRATION_STATE_PATH) return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation((path) => {
      if (path === MIGRATION_STATE_PATH) return `${LEGACY_PATH}\n`;
      throw new Error(`unexpected read: ${String(path)}`);
    });

    const { getEffectiveConfig } = await loadManager();
    getEffectiveConfig();

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
  });

  it('does nothing when no legacy file exists', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { getEffectiveConfig } = await loadManager();
    getEffectiveConfig();

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
  });

  it('does not overwrite a key that already exists in the global config', async () => {
    mockedFs.existsSync.mockImplementation((path) => {
      if (path === LEGACY_PATH) return true;
      if (path === GLOBAL_PATH) return true;
      if (path === '/mock/home/.qianwen') return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation((path) => {
      if (path === LEGACY_PATH) return JSON.stringify({ output: { format: 'json' } });
      if (path === GLOBAL_PATH) return JSON.stringify({ output: { format: 'text' } });
      throw new Error(`unexpected read: ${String(path)}`);
    });

    const { getEffectiveConfig } = await loadManager();
    getEffectiveConfig();

    // Migration must not call writeFileSync — global already has the key.
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    // But the path is still recorded so we don't re-attempt next run.
    expect(mockedFs.appendFileSync).toHaveBeenCalledWith(MIGRATION_STATE_PATH, `${LEGACY_PATH}\n`);
  });
});

describe('validated configuration trust boundary', () => {
  beforeEach(() => vi.resetAllMocks());

  it('migrates a public format but never persists a syntactically valid cwd endpoint', async () => {
    mockedFs.existsSync.mockImplementation((file) => file === LEGACY_PATH);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        output: { format: 'json' },
        api: { endpoint: 'https://attacker.test.qianwenai.com' },
        auth: { endpoint: 'https://attacker.test.qianwenai.com' },
        model: { endpoint: 'https://attacker.test.qianwenai.com' },
        cache: { ttl: '999' },
      }),
    );
    const { getEffectiveConfig } = await loadManager();
    const config = getEffectiveConfig();
    expect(config['api.endpoint']).toBe(s.apiEndpoint);
    expect(config['auth.endpoint']).toBe(s.authEndpoint);
    expect(mockedFs.writeFileSync).toHaveBeenCalledOnce();
    const persisted = String(mockedFs.writeFileSync.mock.calls[0][1]);
    expect(JSON.parse(persisted)).toEqual({ output: { format: 'json' } });
  });

  it('rejects invalid legacy public values without persisting them', async () => {
    mockedFs.existsSync.mockImplementation((file) => file === LEGACY_PATH);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ output: { format: 'bogus' } }));
    const { getEffectiveConfig } = await loadManager();
    expect(getEffectiveConfig()['output.format']).toBe('auto');
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('validates global internal values while retaining explicitly configured valid endpoints', async () => {
    mockedFs.existsSync.mockImplementation((file) => file === GLOBAL_PATH);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        output: { format: 'bogus' },
        api: { endpoint: 'not a url' },
        auth: { endpoint: 'https://auth.test.qianwenai.com' },
        cache: { ttl: '-1' },
      }),
    );
    const { readGlobalConfig } = await loadManager();
    expect(readGlobalConfig()).toEqual({ 'auth.endpoint': 'https://auth.test.qianwenai.com' });
  });
});
