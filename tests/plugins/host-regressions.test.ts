import { directoryState } from '../fixtures/plugin-files.js';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findConfiguredOpenApiPolicy,
  getConfiguredOpenApiRules,
  type OpenApiPolicyRule,
} from '../../src/config/openapi-policy.js';
import { installManagedPlugin, ensureDefaultPlugin } from '../../src/plugins/default-install.js';
import { installLocalPlugin, type InstallTransaction } from '../../src/plugins/installer.js';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import type { InstalledManifest, PluginManifest } from '../../src/plugins/manifest.js';

const state = vi.hoisted(() => ({ root: '', pluginsDir: '', manifestPath: '' }));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getConfigDir: () => state.root,
  getPluginsDir: () => state.pluginsDir,
  getPluginsManifestPath: () => state.manifestPath,
}));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => state.root;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../plugins.preload.json', () => ({ default: { plugins: [] } }));

const packageName = '@qianwenai/host-regressions';
const currentCliVersion = '1.10.0';
const oldPolicy: OpenApiPolicyRule = {
  product: 'RegressionPortal',
  actions: ['ReadOldEntry'],
  auth: 'required',
};
const newPolicy: OpenApiPolicyRule = {
  product: 'RegressionPortal',
  actions: ['ReadCandidateEntry'],
  auth: 'optional',
};
const healthyPolicy: OpenApiPolicyRule = {
  product: 'HealthyRegressionPortal',
  actions: ['ReadHealthyEntry'],
  auth: 'required',
};
const declared: PluginManifest = {
  command: 'regression',
  entry: './index.mjs',
  handlerKey: 'run',
  minCliVersion: '1.0.0',
  apiPolicy: [oldPolicy],
};

function context(): Parameters<typeof installManagedPlugin>[1] {
  return {
    pluginsDir: state.pluginsDir,
    manifestPath: state.manifestPath,
    cliVersion: currentCliVersion,
    definitions: [],
  };
}

function destination(): string {
  return path.join(state.pluginsDir, 'node_modules', packageName);
}

function source(id: string, changes: Partial<PluginManifest> = {}, version = '1.0.0'): string {
  const directory = path.join(state.root, 'sources', id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: packageName, version, qianwen: { ...declared, ...changes } }),
  );
  fs.writeFileSync(
    path.join(directory, 'index.mjs'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(state.root, 'handler-imported'))}, 'unexpected');
export const handlers = { run() {} };
`,
  );
  fs.writeFileSync(path.join(directory, 'content.txt'), id);
  return directory;
}

const snapshot = (directory = state.pluginsDir) => directoryState(directory);

async function seed(): Promise<string> {
  await installManagedPlugin(source('old'), context());
  return fs.readFileSync(state.manifestPath, 'utf8');
}

function addHealthyPolicy(policy: OpenApiPolicyRule): void {
  const name = '@qianwenai/policy-healthy';
  const directory = path.join(state.pluginsDir, 'node_modules', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      qianwen: { ...declared, command: 'healthy', apiPolicy: [policy] },
    }),
  );
  fs.writeFileSync(path.join(directory, 'index.mjs'), 'export const handlers = { run() {} };');
  const manifest = JSON.parse(fs.readFileSync(state.manifestPath, 'utf8')) as InstalledManifest;
  manifest.plugins.push({ name, version: '1.0.0', source: 'local', enabled: true });
  fs.writeFileSync(state.manifestPath, JSON.stringify(manifest));
}

function expectOldInstallation(manifestBefore: string): void {
  expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(manifestBefore);
  expect(fs.readFileSync(path.join(destination(), 'content.txt'), 'utf8')).toBe('old');
  expect(
    JSON.parse(fs.readFileSync(path.join(destination(), 'package.json'), 'utf8')).version,
  ).toBe('1.0.0');
  expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
}

beforeEach(() => {
  const temporaryRoot = path.resolve(__dirname, '../../.local-test-tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  state.root = fs.mkdtempSync(path.join(temporaryRoot, 'host-regressions-'));
  state.pluginsDir = path.join(state.root, 'plugins');
  state.manifestPath = path.join(state.root, 'plugins.json');
  fs.writeFileSync(state.manifestPath, JSON.stringify({ plugins: [] }));
  vi.stubEnv('QIANWEN_CONFIG_DIR', state.root);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Network is forbidden in plugin state tests');
    }),
  );
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(state.root, 'handler-imported'))).toBe(false);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

describe('API policy follows committed, usable plugin state', () => {
  it('does not expose a same-version pending candidate or recover it during a policy read', async () => {
    const before = await seed();
    const candidate = source('candidate', { apiPolicy: [newPolicy] });
    const result = installLocalPlugin(candidate, state.pluginsDir, { recoverable: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const committed = JSON.parse(before) as InstalledManifest;
    expect(result.tx.installationId).toEqual(expect.any(String));
    expect(result.tx.installationId).not.toBe(committed.plugins[0].installationId);
    const filesBefore = snapshot();

    try {
      expect(getConfiguredOpenApiRules()).toEqual([]);
      expect(findConfiguredOpenApiPolicy(newPolicy.product, newPolicy.actions[0])).toBeUndefined();
      expect(snapshot()).toEqual(filesBefore);
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
      expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
    } finally {
      result.tx.rollback();
    }

    expect(getConfiguredOpenApiRules()).toEqual([oldPolicy]);
    await installManagedPlugin(candidate, context());
    expect(getConfiguredOpenApiRules()).toEqual([newPolicy]);
    expect(findConfiguredOpenApiPolicy(oldPolicy.product, oldPolicy.actions[0])).toBeUndefined();
  });

  it('keeps healthy unrelated policy available while a different plugin has a pending install', async () => {
    await seed();
    addHealthyPolicy(oldPolicy);
    const result = installLocalPlugin(
      source('candidate', { apiPolicy: [newPolicy] }),
      state.pluginsDir,
      {
        recoverable: true,
      },
    );
    if (!result.ok) throw new Error(result.error);

    try {
      expect(getConfiguredOpenApiRules()).toEqual([oldPolicy]);
      expect(findConfiguredOpenApiPolicy(newPolicy.product, newPolicy.actions[0])).toBeUndefined();
    } finally {
      result.tx.rollback();
    }
  });

  it.each([
    { reader: 'rules', rollback: false },
    { reader: 'lookup', rollback: false },
    { reader: 'rules', rollback: true },
    { reader: 'lookup', rollback: true },
  ])(
    'does not expose candidate policy when a replacement starts during $reader metadata reading (rollback=$rollback)',
    async ({ reader, rollback }) => {
      await seed();
      addHealthyPolicy(healthyPolicy);
      const before = fs.readFileSync(state.manifestPath, 'utf8');
      const candidate = source('candidate', { apiPolicy: [newPolicy] });
      const packagePath = path.join(destination(), 'package.json');
      const readFile = fs.readFileSync;
      const open = fs.openSync;
      const writeFile = fs.writeFileSync;
      const mkdir = fs.mkdirSync;
      const rename = fs.renameSync;
      const remove = fs.rmSync;
      const unlink = fs.unlinkSync;
      let transaction: InstallTransaction | undefined;
      let interleaved = false;
      let fixtureWriter = false;
      let expectedFiles: ReturnType<typeof snapshot> | undefined;
      const readerMutations: string[] = [];

      const beginReplacement = () => {
        interleaved = true;
        fixtureWriter = true;
        const result = installLocalPlugin(candidate, state.pluginsDir, { recoverable: true });
        if (!result.ok) throw new Error(result.error);
        transaction = result.tx;
        expect(readFile(packagePath, 'utf8')).toContain(newPolicy.actions[0]);
      };
      const finishReplacement = () => {
        if (rollback) {
          transaction?.rollback();
          transaction = undefined;
        }
        expectedFiles = snapshot();
        fixtureWriter = false;
      };

      vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
        if (!fixtureWriter) readerMutations.push('writeFileSync');
        return writeFile(...args);
      });
      vi.spyOn(fs, 'mkdirSync').mockImplementation(((...args: unknown[]) => {
        if (!fixtureWriter) readerMutations.push('mkdirSync');
        return Reflect.apply(mkdir, fs, args);
      }) as typeof fs.mkdirSync);
      vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
        if (!fixtureWriter) readerMutations.push('renameSync');
        return rename(...args);
      });
      vi.spyOn(fs, 'rmSync').mockImplementation((...args) => {
        if (!fixtureWriter) readerMutations.push('rmSync');
        return remove(...args);
      });
      vi.spyOn(fs, 'unlinkSync').mockImplementation((...args) => {
        if (!fixtureWriter) readerMutations.push('unlinkSync');
        return unlink(...args);
      });
      vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
        const writeFlags =
          fs.constants.O_WRONLY |
          fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          fs.constants.O_APPEND;
        const writes = typeof flags === 'string' ? /[wa+]/.test(flags) : (flags & writeFlags) !== 0;
        if (!fixtureWriter && writes) readerMutations.push('openSync for writing');
        if (!interleaved && String(file) === packagePath) {
          beginReplacement();
          const descriptor = open(file, flags, mode);
          finishReplacement();
          return descriptor;
        }
        return open(file, flags, mode);
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
        if (!interleaved && String(args[0]) === packagePath) {
          beginReplacement();
          const bytes: unknown = Reflect.apply(readFile, fs, args);
          finishReplacement();
          return bytes;
        }
        return Reflect.apply(readFile, fs, args);
      }) as typeof fs.readFileSync);

      try {
        const result =
          reader === 'rules'
            ? getConfiguredOpenApiRules()
            : findConfiguredOpenApiPolicy(newPolicy.product, newPolicy.actions[0]);

        expect(interleaved).toBe(true);
        if (reader === 'rules') {
          expect(result).not.toContainEqual(newPolicy);
          expect(result).toContainEqual(healthyPolicy);
        } else {
          expect(result).toBeUndefined();
        }
        expect(
          findConfiguredOpenApiPolicy(healthyPolicy.product, healthyPolicy.actions[0]),
        ).toEqual(healthyPolicy);
        expect(snapshot()).toEqual(expectedFiles);
        expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
        expect(readerMutations).toEqual([]);
        expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
      } finally {
        vi.restoreAllMocks();
        transaction?.rollback();
      }

      expect(getConfiguredOpenApiRules()).toEqual([oldPolicy, healthyPolicy]);
    },
  );

  it('keeps committed policy hidden until transaction cleanup finishes', async () => {
    await seed();
    const candidate = source('candidate', { apiPolicy: [newPolicy] });
    const remove = fs.rmSync;
    const failCleanup = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (String(file).includes('.qianwen-bak-')) throw new Error('Fixture cleanup failure');
      return remove(file, options);
    });
    await installManagedPlugin(candidate, context());
    failCleanup.mockRestore();
    const before = snapshot();
    const manifestBefore = fs.readFileSync(state.manifestPath, 'utf8');

    expect(getConfiguredOpenApiRules()).toEqual([]);
    expect(findConfiguredOpenApiPolicy(newPolicy.product, newPolicy.actions[0])).toBeUndefined();
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(manifestBefore);

    await expect(
      installManagedPlugin(path.join(state.root, 'missing-source'), context()),
    ).rejects.toThrow();
    expect(getConfiguredOpenApiRules()).toEqual([newPolicy]);
  });

  it('continues to read stable legacy policy without an installation identity', async () => {
    await seed();
    const manifest = JSON.parse(fs.readFileSync(state.manifestPath, 'utf8')) as InstalledManifest;
    delete manifest.plugins[0].installationId;
    fs.writeFileSync(state.manifestPath, JSON.stringify(manifest));
    const before = snapshot();

    expect(getConfiguredOpenApiRules()).toEqual([oldPolicy]);
    expect(snapshot()).toEqual(before);
  });
});

describe('plugin validation retains actionable error categories', () => {
  it.each(['missing', 'missing-parent', 'non-directory-parent', 'directory'] as const)(
    'rejects a %s entry as plugin validation and restores the old package',
    async (kind) => {
      const before = await seed();
      const entry = kind.endsWith('parent')
        ? './parent/unusable-entry.mjs'
        : './unusable-entry.mjs';
      const candidate = source('candidate', { entry }, '2.0.0');
      if (kind === 'directory') fs.mkdirSync(path.join(candidate, 'unusable-entry.mjs'));
      if (kind === 'non-directory-parent') fs.writeFileSync(path.join(candidate, 'parent'), 'file');

      const error: unknown = await installManagedPlugin(candidate, context()).catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({
        code: 'PLUGIN_ENTRY_INVALID',
        exitCode: 4,
        message: expect.stringContaining(packageName),
      });
      expect(error).toMatchObject({
        message: expect.stringContaining(entry),
      });
      expectOldInstallation(before);
    },
  );

  it('preserves an entry permission error instead of misreporting it as a missing entry', async () => {
    const before = await seed();
    const candidate = source('candidate', {}, '2.0.0');
    const failure = Object.assign(new Error('Fixture entry permission failure'), {
      code: 'EACCES',
    });
    const realpath = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((file: fs.PathLike) => {
      if (String(file) === path.join(destination(), 'index.mjs')) throw failure;
      return realpath(file);
    }) as typeof fs.realpathSync);

    await expect(installManagedPlugin(candidate, context())).rejects.toBe(failure);
    expectOldInstallation(before);
  });

  it('classifies a candidate minimum CLI mismatch without replacing the installed package', async () => {
    const before = await seed();
    const candidate = source('candidate', { minCliVersion: '99.0.0' }, '2.0.0');

    await expect(installManagedPlugin(candidate, context())).rejects.toMatchObject({
      code: 'PLUGIN_CLI_INCOMPATIBLE',
      exitCode: 4,
      minCliVersion: '99.0.0',
      currentCliVersion,
    });
    expectOldInstallation(before);
  });

  it.each(['', ' ', '\t\n'])(
    'rejects a local candidate with explicit blank minimum %j and restores the old installation',
    async (minCliVersion) => {
      const before = await seed();
      const candidate = source('candidate', { minCliVersion }, '2.0.0');
      const packagePath = path.join(candidate, 'package.json');
      const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
      metadata.engines = { '@qianwenai/qianwen-cli': '>=1.0.0' };
      fs.writeFileSync(packagePath, JSON.stringify(metadata));

      const error: unknown = await installManagedPlugin(candidate, context()).catch(
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        exitCode: 1,
        message: expect.stringMatching(/invalid minCliVersion/i),
      });
      expect(error).not.toMatchObject({ code: 'PLUGIN_CLI_INCOMPATIBLE' });
      expectOldInstallation(before);
    },
  );

  it.each([undefined, '1.0'])(
    'accepts a local candidate with omitted or legal abbreviated minimum %j',
    async (minCliVersion) => {
      await seed();
      const candidate = source('candidate', { minCliVersion }, '2.0.0');

      const installed = await installManagedPlugin(candidate, context());

      expect(installed.version).toBe('2.0.0');
      expect(fs.readFileSync(path.join(destination(), 'content.txt'), 'utf8')).toBe('candidate');
    },
  );

  it('retains the same structured incompatibility for an installed default without downloading', async () => {
    await seed();
    const packagePath = path.join(destination(), 'package.json');
    const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      qianwen: PluginManifest;
    };
    metadata.qianwen.minCliVersion = '99.0.0';
    fs.writeFileSync(packagePath, JSON.stringify(metadata));
    const before = snapshot();
    const configured: DefaultPlugin = {
      name: packageName,
      version: '1.0.0',
      command: declared.command,
      source: { type: 'archive', path: path.join(state.root, 'must-not-download.tgz') },
    };

    await expect(
      ensureDefaultPlugin(configured, { ...context(), definitions: [configured] }),
    ).rejects.toMatchObject({
      code: 'PLUGIN_CLI_INCOMPATIBLE',
      exitCode: 4,
      minCliVersion: '99.0.0',
      currentCliVersion,
    });
    expect(snapshot()).toEqual(before);
  });
});
