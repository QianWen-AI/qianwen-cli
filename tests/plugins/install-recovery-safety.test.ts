import { directoryState } from '../fixtures/plugin-files.js';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import type { InstalledManifest, PluginManifest } from '../../src/plugins/manifest.js';
import { readInstalledManifest, writeInstalledManifest } from '../../src/plugins/manifest.js';
import { installLocalPlugin, type InstallTransaction } from '../../src/plugins/installer.js';
import {
  ensureDefaultPlugin,
  installManagedPlugin,
  readUsableDefaultPlugin,
} from '../../src/plugins/default-install.js';
import { loadInstalledPlugins } from '../../src/plugins/loader.js';
import { initializeDefaultPlugins } from '../../src/plugins/initialize.js';

const state = vi.hoisted(() => ({
  root: '',
  pluginsDir: '',
  manifestPath: '',
  defaults: [] as DefaultPlugin[],
}));

vi.mock('../../src/plugins/defaults.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/defaults.js')>()),
  getDefaultPlugins: () => state.defaults,
  getDefaultPlugin: (name: string) => state.defaults.find((item) => item.name === name),
}));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getPluginsDir: () => state.pluginsDir,
  getPluginsManifestPath: () => state.manifestPath,
}));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => state.root;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../src/config/manager.js', () => ({
  getEffectiveConfig: () => ({ 'output.format': 'json' }),
}));
vi.mock('../../src/auth/credentials.js', () => ({
  getCredentials: () => null,
  resolveCredentials: () => null,
  ensureAuthenticated: () => {
    throw new Error('Recovery fixtures must not request credentials');
  },
}));
vi.mock('../../src/api/api-client.js', () => ({
  createApiClient: () => ({ callFlatApi: vi.fn() }),
}));

const workspace = path.resolve(__dirname, '../..');
const packageName = '@qianwenai/safety-ordinary';
const healthyName = '@qianwenai/safety-healthy';
const declared: PluginManifest = {
  command: 'safetyordinary',
  entry: './index.mjs',
  handlerKey: 'run',
  minCliVersion: '1.0.0',
};

function context(): Parameters<typeof ensureDefaultPlugin>[1] {
  return {
    pluginsDir: state.pluginsDir,
    manifestPath: state.manifestPath,
    cliVersion: '1.10.0',
    definitions: state.defaults,
    lockTimeoutMs: 1_000,
    lockPollMs: 10,
  };
}

function source(name = packageName, version = '1.0.0', content = 'old'): string {
  const directory = path.join(state.root, 'sources', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name,
      version,
      qianwen: {
        ...declared,
        command: name === packageName ? declared.command : 'safetyhealthy',
        description: content,
      },
    }),
  );
  fs.writeFileSync(path.join(directory, 'index.mjs'), 'export const handlers = { run() {} };');
  fs.writeFileSync(path.join(directory, 'content.txt'), content);
  return directory;
}

function destination(name = packageName): string {
  return path.join(state.pluginsDir, 'node_modules', name);
}

function journalFiles(): string[] {
  const directory = path.join(state.pluginsDir, '.install-transactions');
  return fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => path.join(directory, entry))
    : [];
}

const snapshot = (directory = state.pluginsDir) => directoryState(directory);

async function seed(): Promise<string> {
  await installManagedPlugin(source(), context());
  return fs.readFileSync(state.manifestPath, 'utf8');
}

function pending(version = '2.0.0'): InstallTransaction {
  const result = installLocalPlugin(source(packageName, version, 'new'), state.pluginsDir, {
    recoverable: true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(journalFiles()).toHaveLength(1);
  return result.tx;
}

async function recoverWithMissingInput(): Promise<void> {
  await expect(
    installManagedPlugin(path.join(state.root, 'missing-source'), context()),
  ).rejects.toThrow();
}

beforeEach(() => {
  const temporaryRoot = path.join(workspace, '.local-test-tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  state.root = fs.mkdtempSync(path.join(temporaryRoot, 'install-recovery-safety-'));
  state.pluginsDir = path.join(state.root, 'plugins');
  state.manifestPath = path.join(state.root, 'plugins.json');
  state.defaults = [];
  fs.writeFileSync(state.manifestPath, JSON.stringify({ plugins: [] }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Network is forbidden in recovery safety tests');
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('recovery safety and ordinary plugin entry points', () => {
  it.each(['npm', 'local', 'archive'] as const)(
    'keeps a pending %s plugin untouched and gives a retry hint appropriate to its source',
    async (pluginSource) => {
      await seed();
      await installManagedPlugin(source(healthyName), context());
      const manifest = readInstalledManifest(state.manifestPath);
      const ordinary = manifest.plugins.find((plugin) => plugin.name === packageName);
      if (!ordinary) throw new Error('Missing ordinary plugin fixture');
      ordinary.source = pluginSource;
      writeInstalledManifest(state.manifestPath, manifest);
      pending('1.0.0');
      const before = snapshot();
      const manifestBefore = fs.readFileSync(state.manifestPath, 'utf8');

      const loaded = loadInstalledPlugins(state.manifestPath, state.pluginsDir);

      expect(loaded.map((plugin) => plugin.name)).toEqual([healthyName]);
      const diagnostic = vi
        .mocked(process.stderr.write)
        .mock.calls.map(([value]) => value)
        .join('');
      expect(diagnostic).toContain(`"${packageName}" has an interrupted installation.`);
      if (pluginSource === 'npm') {
        expect(diagnostic).toContain(`Run: qianwen plugin install ${packageName}`);
        expect(diagnostic).not.toContain('<path>');
      } else {
        expect(diagnostic).toContain(
          'Reinstall from the original local plugin directory: qianwen plugin install <path>',
        );
        expect(diagnostic).not.toContain(`plugin install ${packageName}`);
        expect(diagnostic).not.toContain(destination());
      }
      expect(diagnostic).not.toContain('plugin prepare');
      expect(snapshot()).toEqual(before);
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(manifestBefore);
      expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
    },
  );

  it.each(['no defaults', 'healthy default', 'disabled default'])(
    'internal initialization recovers an ordinary plugin with %s and does not reinstall it',
    async (configuration) => {
      const before = await seed();
      if (configuration !== 'no defaults') {
        state.defaults = [
          {
            name: healthyName,
            version: '1.0.0',
            command: 'safetyhealthy',
            source: { type: 'archive', path: path.join(state.root, 'missing-archive.tgz') },
          },
        ];
        await installManagedPlugin(source(healthyName), context());
        if (configuration === 'disabled default') {
          const manifest = readInstalledManifest(state.manifestPath);
          manifest.disabledDefaults = [healthyName];
          writeInstalledManifest(state.manifestPath, manifest);
        }
      }
      const expectedManifest =
        configuration === 'no defaults' ? before : fs.readFileSync(state.manifestPath, 'utf8');
      pending('1.0.0');
      const cmd = new Command('qianwen');

      await initializeDefaultPlugins(cmd);

      expect(fs.readFileSync(path.join(destination(), 'content.txt'), 'utf8')).toBe('old');
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(expectedManifest);
      expect(journalFiles()).toEqual([]);
      expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
      await initializeDefaultPlugins(cmd);
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(expectedManifest);
    },
  );

  it.each(['invalid JSON', 'staging traversal', 'package traversal', 'wrong filename'])(
    'retains all package files when the journal has %s',
    async (corruption) => {
      const before = await seed();
      pending();
      const [file] = journalFiles();
      const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (corruption === 'invalid JSON') fs.writeFileSync(file, '[');
      else if (corruption === 'wrong filename') fs.renameSync(file, `${file}.unexpected.json`);
      else {
        journal[corruption === 'staging traversal' ? 'staging' : 'name'] = '../outside';
        fs.writeFileSync(file, JSON.stringify(journal));
      }
      const filesBefore = snapshot();

      await expect(
        installManagedPlugin(path.join(state.root, 'missing-source'), context()),
      ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_RECOVERY_FAILED', exitCode: 4 });

      expect(snapshot()).toEqual(filesBefore);
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
      expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
    },
  );

  it.each(['destination', 'backup', 'journal'])(
    'refuses a symbolic-link %s before recovery can touch its target',
    async (link) => {
      const before = await seed();
      const transaction = pending();
      const victim = path.join(state.root, 'outside-plugin-directory');
      fs.mkdirSync(victim);
      fs.writeFileSync(path.join(victim, 'sentinel'), 'keep');
      const candidate =
        link === 'destination'
          ? destination()
          : link === 'backup'
            ? `${destination()}.qianwen-bak-${transaction.installationId}`
            : journalFiles()[0];
      fs.rmSync(candidate, { recursive: true, force: true });
      fs.symlinkSync(victim, candidate);
      const filesBefore = snapshot();

      await expect(
        installManagedPlugin(path.join(state.root, 'missing-source'), context()),
      ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_RECOVERY_FAILED', exitCode: 4 });

      expect(fs.readFileSync(path.join(victim, 'sentinel'), 'utf8')).toBe('keep');
      expect(snapshot()).toEqual(filesBefore);
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
    },
  );

  it('retries recovery after restoring the backup failed without losing the old package', async () => {
    const before = await seed();
    const transaction = pending();
    const backup = `${destination()}.qianwen-bak-${transaction.installationId}`;
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === backup) throw new Error('Fixture backup rename failure');
      return rename(from, to);
    });

    await expect(
      installManagedPlugin(path.join(state.root, 'missing-source'), context()),
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_RECOVERY_FAILED', exitCode: 4 });
    expect(fs.readFileSync(path.join(backup, 'content.txt'), 'utf8')).toBe('old');
    expect(journalFiles()).toHaveLength(1);
    failure.mockRestore();

    await recoverWithMissingInput();

    expect(fs.readFileSync(path.join(destination(), 'content.txt'), 'utf8')).toBe('old');
    expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
    expect(journalFiles()).toEqual([]);
    await recoverWithMissingInput();
    expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
  });

  it.each(['enabled false', 'disabledDefaults'])(
    'retains committed new content and a later manual %s state while retrying cleanup',
    async (disable) => {
      await seed();
      const remove = fs.rmSync;
      const failure = vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
        if (String(candidate).includes('.qianwen-bak-')) throw new Error('Fixture cleanup failure');
        return remove(candidate, options);
      });
      const record = await installManagedPlugin(source(packageName, '1.0.0', 'new'), context());
      expect(record.version).toBe('1.0.0');
      expect(journalFiles()).toHaveLength(1);
      failure.mockRestore();
      const manifest: InstalledManifest = readInstalledManifest(state.manifestPath);
      if (disable === 'enabled false') manifest.plugins[0].enabled = false;
      else manifest.disabledDefaults = [packageName];
      writeInstalledManifest(state.manifestPath, manifest);
      const before = fs.readFileSync(state.manifestPath, 'utf8');

      await recoverWithMissingInput();

      expect(fs.readFileSync(path.join(destination(), 'content.txt'), 'utf8')).toBe('new');
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
      expect(journalFiles()).toEqual([]);
    },
  );

  it('read-only default inspection leaves the pending transaction untouched', async () => {
    await seed();
    const configured: DefaultPlugin = {
      name: packageName,
      version: '1.0.0',
      command: declared.command,
      source: { type: 'archive', path: path.join(state.root, 'missing-archive.tgz') },
    };
    state.defaults = [configured];
    pending('1.0.0');
    const before = snapshot();
    const manifestBefore = fs.readFileSync(state.manifestPath, 'utf8');

    expect(readUsableDefaultPlugin(configured, context())).toBeNull();

    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(manifestBefore);
    expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
  });

  it('continues to reuse a healthy legacy record without an installationId', async () => {
    await seed();
    const manifest = readInstalledManifest(state.manifestPath);
    delete manifest.plugins[0].installationId;
    writeInstalledManifest(state.manifestPath, manifest);
    const before = fs.readFileSync(state.manifestPath, 'utf8');
    const configured: DefaultPlugin = {
      name: packageName,
      version: '1.0.0',
      command: declared.command,
      source: { type: 'archive', path: path.join(state.root, 'missing-archive.tgz') },
    };

    const result = await ensureDefaultPlugin(configured, context());

    expect(result.version).toBe('1.0.0');
    expect(result.installationId).toBeUndefined();
    expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
    expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
  });
});
