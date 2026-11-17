import { writePluginPackage, npmRecord, writeInstalledPlugins } from '../fixtures/plugin-files.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import type { InstallResult } from '../../src/plugins/installer.js';
import type {
  InstalledManifest,
  InstalledPlugin,
  PluginManifest,
} from '../../src/plugins/manifest.js';
import { ensureDefaultPlugin } from '../../src/plugins/default-install.js';
import { installLocalPlugin } from '../../src/plugins/installer.js';

const registry = vi.hoisted(() => ({
  install: vi.fn<(spec: string, pluginsDir: string) => Promise<InstallResult>>(),
}));

vi.mock('../../src/plugins/installer.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/installer.js')>()),
  installNpmPlugin: registry.install,
}));

const workspace = path.resolve(__dirname, '../..');
const packageName = '@qianwenai/fastpath-default';
const baseManifest: PluginManifest = {
  command: 'fastcatalog',
  commandAliases: ['fastcat'],
  entry: './index.mjs',
  handlerKey: 'run',
  minCliVersion: '1.0.0',
};

let root: string;
let pluginsDir: string;
let manifestPath: string;
let packages: Map<string, string>;

function definition(overrides: Partial<DefaultPlugin> = {}): DefaultPlugin {
  return {
    name: packageName,
    version: '1.2.3',
    command: baseManifest.command,
    commandAliases: baseManifest.commandAliases,
    source: { type: 'npm' },
    ...overrides,
  };
}

function context(
  definitions: readonly DefaultPlugin[] = [definition()],
): Parameters<typeof ensureDefaultPlugin>[1] {
  return {
    pluginsDir,
    manifestPath,
    cliVersion: '1.10.0',
    reservedNames: new Set(['models', 'm', 'plugin']),
    definitions,
    lockTimeoutMs: 1_000,
    lockPollMs: 5,
  };
}

function packagePath(name = packageName): string {
  return path.join(pluginsDir, 'node_modules', name);
}

function writePackage(
  directory: string,
  name = packageName,
  version = '1.2.3',
  manifest: PluginManifest = baseManifest,
): string {
  return writePluginPackage(
    directory,
    name,
    version,
    manifest,
    'export const handlers = { run() {} };',
  );
}

function providePackage(configured = definition(), manifest = baseManifest): void {
  packages.set(
    `${configured.name}@${configured.version}`,
    writePackage(
      path.join(root, 'registry', configured.name, configured.version),
      configured.name,
      configured.version,
      manifest,
    ),
  );
}

function seedInstalled(version = '1.2.3', manifest = baseManifest): InstalledPlugin {
  writePackage(packagePath(), packageName, version, manifest);
  return npmRecord(packageName, version, manifest);
}

const writeInstalled = (plugins: InstalledPlugin[], disabledDefaults?: string[]) =>
  writeInstalledPlugins(manifestPath, plugins, disabledDefaults);

function installed(): InstalledManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledManifest;
}

function observeLockCreation() {
  const mkdir = vi.spyOn(fs, 'mkdirSync');
  const mkdirAsync = vi.spyOn(fsPromises, 'mkdir');
  const open = vi.spyOn(fs, 'openSync');
  const openAsync = vi.spyOn(fsPromises, 'open');
  return () =>
    [
      ...mkdir.mock.calls,
      ...mkdirAsync.mock.calls,
      ...open.mock.calls,
      ...openAsync.mock.calls,
    ].filter(([target]) => String(target).startsWith(`${manifestPath}.lock`));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function blockDownload(spec: string) {
  const started = deferred();
  const released = deferred();
  const install = registry.install.getMockImplementation();
  if (!install) throw new Error('Missing fixture installer');
  registry.install.mockImplementation(async (requested, target) => {
    if (requested === spec) {
      started.resolve();
      await released.promise;
    }
    return install(requested, target);
  });
  return { started: started.promise, release: released.resolve };
}

function otherDefault(): { configured: DefaultPlugin; manifest: PluginManifest } {
  const manifest = { ...baseManifest, command: 'slowcatalog', commandAliases: ['slowcat'] };
  return {
    configured: definition({
      name: '@qianwenai/slow-default',
      command: manifest.command,
      commandAliases: manifest.commandAliases,
    }),
    manifest,
  };
}

beforeEach(() => {
  const temporaryRoot = path.join(workspace, '.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  root = mkdtempSync(path.join(temporaryRoot, 'default-fastpath-'));
  pluginsDir = path.join(root, 'plugins');
  manifestPath = path.join(root, 'plugins.json');
  packages = new Map();
  registry.install.mockReset();
  registry.install.mockImplementation(async (spec, target) => {
    const source = packages.get(spec);
    if (!source) return { ok: false, error: `No fixture for ${spec}` };
    return installLocalPlugin(source, target);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Network is forbidden in this test');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('healthy default plugin fast path', () => {
  it.each(['1.2.3', '4.5.6'])(
    'reuses compatible version %s without creating a manifest lock or modifying files',
    async (version) => {
      const record = seedInstalled(version);
      writeInstalled([record], ['@qianwenai/unrelated-disabled']);
      const before = readFileSync(manifestPath, 'utf8');
      const entry = path.join(packagePath(), 'index.mjs');
      const entryBefore = readFileSync(entry, 'utf8');
      const lockCreations = observeLockCreation();

      const result = await ensureDefaultPlugin(definition(), context());

      expect(result).toEqual(record);
      expect(lockCreations()).toEqual([]);
      expect(readFileSync(manifestPath, 'utf8')).toBe(before);
      expect(readFileSync(entry, 'utf8')).toBe(entryBefore);
      expect(registry.install).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('completes healthy plugin preparation while another plugin holds the download lock', async () => {
    const record = seedInstalled('4.5.6');
    writeInstalled([record], ['@qianwenai/unrelated-disabled']);
    const before = readFileSync(manifestPath, 'utf8');
    const other = otherDefault();
    providePackage(other.configured, other.manifest);
    const held = blockDownload(`${other.configured.name}@${other.configured.version}`);
    const shared = context([definition(), other.configured]);
    const owner = ensureDefaultPlugin(other.configured, shared);

    try {
      await held.started;
      expect(existsSync(`${manifestPath}.lock`)).toBe(true);

      const result = await ensureDefaultPlugin(definition(), {
        ...shared,
        lockTimeoutMs: 80,
      });

      expect(result).toEqual(record);
      expect(existsSync(`${manifestPath}.lock`)).toBe(true);
      expect(readFileSync(manifestPath, 'utf8')).toBe(before);
      expect(registry.install.mock.calls.map(([spec]) => spec)).toEqual([
        `${other.configured.name}@${other.configured.version}`,
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      held.release();
      await owner;
    }

    expect(installed().plugins.find(({ name }) => name === packageName)).toEqual(record);
    expect(installed().disabledDefaults).toEqual(['@qianwenai/unrelated-disabled']);
  });
});

describe('default plugin writes retain locking and validation', () => {
  it.each([
    'missing plugin',
    'older version',
    'missing entry',
    'mismatched version',
    'invalid version',
    'invalid manifest',
    'escaped entry',
  ])('does not bypass the write lock for %s', async (fault) => {
    const record = seedInstalled(fault === 'older version' ? '1.0.0' : '2.0.0');
    writeInstalled(
      fault === 'missing plugin'
        ? []
        : [fault === 'mismatched version' ? { ...record, version: '9.9.9' } : record],
    );
    if (fault === 'missing entry') rmSync(path.join(packagePath(), 'index.mjs'));
    if (fault === 'invalid version') {
      writePackage(packagePath(), packageName, 'invalid');
      writeInstalled([{ ...record, version: 'invalid' }]);
    }
    if (fault === 'invalid manifest') {
      writeFileSync(
        path.join(packagePath(), 'package.json'),
        JSON.stringify({
          name: packageName,
          version: record.version,
          qianwen: { ...baseManifest, command: 123 },
        }),
      );
    }
    if (fault === 'escaped entry') {
      const outside = path.join(root, 'outside.mjs');
      writeFileSync(outside, 'export const handlers = { run() {} };');
      rmSync(path.join(packagePath(), 'index.mjs'));
      symlinkSync(outside, path.join(packagePath(), 'index.mjs'));
    }
    providePackage();
    const other = otherDefault();
    providePackage(other.configured, other.manifest);
    const held = blockDownload(`${other.configured.name}@${other.configured.version}`);
    const shared = context([definition(), other.configured]);
    const owner = ensureDefaultPlugin(other.configured, shared);

    try {
      await held.started;
      const before = readFileSync(manifestPath, 'utf8');
      expect(existsSync(`${manifestPath}.lock`)).toBe(true);

      await expect(
        ensureDefaultPlugin(definition(), { ...shared, lockTimeoutMs: 50 }),
      ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_LOCK_TIMEOUT', exitCode: 4 });

      expect(readFileSync(manifestPath, 'utf8')).toBe(before);
      expect(registry.install.mock.calls.map(([spec]) => spec)).toEqual([
        `${other.configured.name}@${other.configured.version}`,
      ]);
    } finally {
      held.release();
      await owner;
    }

    const result = await ensureDefaultPlugin(definition(), shared);
    expect(result).toMatchObject({ name: packageName, version: '1.2.3', enabled: true });
    expect(registry.install.mock.calls.map(([spec]) => spec)).toEqual([
      `${other.configured.name}@${other.configured.version}`,
      `${packageName}@1.2.3`,
    ]);
    expect(
      installed()
        .plugins.map(({ name }) => name)
        .sort(),
    ).toEqual([packageName, other.configured.name].sort());
    expect(existsSync(`${manifestPath}.lock`)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks after the first writer finishes so concurrent requests download only once', async () => {
    writeInstalled([], ['@qianwenai/unrelated-disabled']);
    providePackage();
    const held = blockDownload(`${packageName}@1.2.3`);
    const shared = context();
    const lockCreations = observeLockCreation();
    const owner = ensureDefaultPlugin(definition(), shared);
    let waiter: ReturnType<typeof ensureDefaultPlugin> | undefined;

    try {
      await held.started;
      expect(existsSync(`${manifestPath}.lock`)).toBe(true);
      expect(lockCreations().length).toBeGreaterThan(0);
      expect(installed().plugins).toEqual([]);
      waiter = ensureDefaultPlugin(definition(), shared);
    } finally {
      held.release();
      await owner;
    }

    expect(await waiter).toMatchObject({ name: packageName, version: '1.2.3', enabled: true });
    expect(registry.install).toHaveBeenCalledOnce();
    expect(installed().plugins).toHaveLength(1);
    expect(installed().disabledDefaults).toEqual(['@qianwenai/unrelated-disabled']);
    expect(existsSync(`${manifestPath}.lock`)).toBe(false);
  });

  it.each(['disabled default', 'disabled record', 'CLI incompatible', 'aborted'])(
    'does not return a healthy fast-path result for %s',
    async (state) => {
      const record = seedInstalled(
        '4.5.6',
        state === 'CLI incompatible' ? { ...baseManifest, minCliVersion: '99.0.0' } : baseManifest,
      );
      writeInstalled(
        [state === 'disabled record' ? { ...record, enabled: false } : record],
        state === 'disabled default' ? [packageName] : undefined,
      );
      const before = readFileSync(manifestPath, 'utf8');
      const controller = new AbortController();
      if (state === 'aborted') controller.abort();

      await expect(
        ensureDefaultPlugin(definition(), { ...context(), signal: controller.signal }),
      ).rejects.toMatchObject(
        state === 'aborted'
          ? { name: 'AbortError' }
          : {
              code:
                state === 'CLI incompatible'
                  ? 'PLUGIN_CLI_INCOMPATIBLE'
                  : 'PLUGIN_DEFAULT_DISABLED',
            },
      );

      expect(readFileSync(manifestPath, 'utf8')).toBe(before);
      expect(registry.install).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
