import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { validateDefaultConfig, type DefaultPlugin } from '../../src/plugins/defaults.js';
import { ensureDefaultPlugin, installManagedPlugin } from '../../src/plugins/default-install.js';
import {
  readInstalledManifest,
  readPluginPackageManifest,
  type InstalledPlugin,
  type PluginManifest,
} from '../../src/plugins/manifest.js';
import { resolveRegistryForPackage } from '../../src/plugins/npm-registry.js';
import { buildTarball } from '../fixtures/tar-builder.js';

const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => isolated.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const packageName = '@qianwenai/preload-contract';
const configuredRegistry = 'https://configured.test.qianwenai.com/team/';
const userRegistry = 'https://user.test.qianwenai.com/';
const packageManifest: PluginManifest = {
  command: 'catalog',
  commandAliases: ['catg'],
  entry: './index.mjs',
  minCliVersion: '1.0.0',
  auth: 'optional',
  subcommands: [
    {
      command: 'explore [query]',
      handlerKey: 'explore',
      options: [{ flag: '--locale <locale>', description: 'Result language' }],
    },
  ],
};

let root: string;
let pluginsDir: string;
let manifestPath: string;
let packages: Map<string, Buffer>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function definition(overrides: Partial<DefaultPlugin> = {}): DefaultPlugin {
  return {
    name: packageName,
    version: '1.2.3',
    command: 'catalog',
    commandAliases: ['catg'],
    source: { type: 'npm', registry: configuredRegistry },
    ...overrides,
  };
}

function context(configured = definition()): Parameters<typeof ensureDefaultPlugin>[1] {
  return {
    pluginsDir,
    manifestPath,
    cliVersion: '1.10.0-plugin.5',
    definitions: [configured],
    reservedNames: new Set(['models', 'plugin']),
    archiveRoot: root,
  };
}

function packageBytes(
  version: string,
  manifest: PluginManifest = packageManifest,
  name = packageName,
): Buffer {
  return buildTarball([
    {
      name: 'package/package.json',
      data: JSON.stringify({ name, version, main: './index.mjs', qianwen: manifest }),
    },
    {
      name: 'package/index.mjs',
      data: `export const handlers = { explore() { return ${JSON.stringify(version)}; } };`,
    },
  ]);
}

function providePackage(
  version = '1.2.3',
  manifest: PluginManifest = packageManifest,
  name = packageName,
): void {
  packages.set(version, packageBytes(version, manifest, name));
}

function seedInstalled(
  version: string,
  source: InstalledPlugin['source'] = 'npm',
  manifest: PluginManifest = packageManifest,
): string {
  const directory = path.join(pluginsDir, 'node_modules', packageName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: packageName, version, qianwen: manifest }),
  );
  writeFileSync(path.join(directory, 'index.mjs'), 'export const handlers = { explore() {} };');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      plugins: [
        {
          name: packageName,
          version,
          source,
          enabled: true,
          command: 'catalog',
          commandAliases: ['catg'],
          ...(source === 'local' ? { path: directory } : {}),
        },
      ],
    }),
  );
  return directory;
}

function snapshot(directory: string): Record<string, { bytes: string; mtimeMs: number }> {
  return Object.fromEntries(
    [manifestPath, path.join(directory, 'package.json'), path.join(directory, 'index.mjs')].map(
      (file) => [file, { bytes: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs }],
    ),
  );
}

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : String(input),
  );
}

beforeEach(() => {
  const temporaryRoot = path.resolve(__dirname, '../../.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  root = mkdtempSync(path.join(temporaryRoot, 'preload-contract-'));
  isolated.home = path.join(root, 'home');
  mkdirSync(isolated.home);
  pluginsDir = path.join(root, 'plugins');
  manifestPath = path.join(root, 'plugins.json');
  packages = new Map();
  writeFileSync(path.join(isolated.home, '.npmrc'), `registry=${userRegistry}\n`);
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    if (![new URL(configuredRegistry).host, new URL(userRegistry).host].includes(url.host)) {
      throw new Error(`No network fixture for ${href}`);
    }
    if (url.pathname.endsWith('.tgz')) {
      const version = path.basename(url.pathname, '.tgz');
      const bytes = packages.get(version);
      if (!bytes) return new Response('Missing fixture archive', { status: 404 });
      return new Response(new Uint8Array(bytes), { status: 200 });
    }
    const versions = Object.fromEntries(
      [...packages].map(([version, bytes]) => [
        version,
        {
          name: packageName,
          version,
          qianwen: packageManifest,
          dist: {
            tarball: `${url.origin}/archives/${version}.tgz`,
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
          },
        },
      ]),
    );
    return Response.json({
      'dist-tags': { latest: [...packages.keys()].at(-1) },
      versions,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('preload configuration contains installation identity only', () => {
  it('accepts npm identity and explicit registry without a copied manifest or API policy', () => {
    const configured = definition();
    expect(validateDefaultConfig({ plugins: [configured] })).toEqual([configured]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts archive identity and digest without inspecting its contents', () => {
    const configured = definition({
      source: { type: 'archive', path: './not-created.tgz' },
      sha256: 'a'.repeat(64),
    });
    expect(validateDefaultConfig({ plugins: [configured] })).toEqual([configured]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['manifest', 'minCliVersion', 'api'])(
    'rejects host-owned %s metadata in a minimal preload entry',
    (field) => {
      const value = field === 'manifest' ? packageManifest : field === 'api' ? [] : '1.0.0';
      expect(() =>
        validateDefaultConfig({ plugins: [{ ...definition(), [field]: value }] }),
      ).toThrow();
    },
  );

  it.each(['catalog search', 'catalog [query]', '--catalog', ''])(
    'requires a single top-level command token: %j',
    (command) => {
      expect(() => validateDefaultConfig({ plugins: [definition({ command })] })).toThrow();
    },
  );

  it('rejects a default alias owned by another entry', () => {
    expect(() =>
      validateDefaultConfig({
        plugins: [
          definition(),
          definition({ name: '@qianwenai/second', command: 'other', commandAliases: ['catg'] }),
        ],
      }),
    ).toThrow();
  });

  it.each([
    'http://registry.test.qianwenai.com/',
    'https://user:password@registry.test.qianwenai.com/',
    'https://registry.test.qianwenai.com/?private=value',
    'https://registry.test.qianwenai.com/#fragment',
    'https://registry.test.qianwenai.com/?',
    'https://registry.test.qianwenai.com/#',
    'registry.test.qianwenai.com',
  ])('rejects an unsafe explicit registry: %s', (registry) => {
    expect(() =>
      validateDefaultConfig({ plugins: [definition({ source: { type: 'npm', registry } })] }),
    ).toThrow();
  });
});

describe('explicit registry selection and authentication isolation', () => {
  it('overrides scope/global selection and matches authentication only at the final registry', () => {
    writeFileSync(
      path.join(isolated.home, '.npmrc'),
      [
        `registry=${userRegistry}`,
        `@qianwenai:registry=${userRegistry}`,
        '//user.test.qianwenai.com/:_authToken=synthetic-wrong-registry',
        '//configured.test.qianwenai.com/:_authToken=synthetic-host',
        '//configured.test.qianwenai.com/team/:_authToken=synthetic-team',
      ].join('\n'),
    );
    expect(resolveRegistryForPackage(packageName, isolated.home, configuredRegistry)).toEqual({
      registry: configuredRegistry,
      authToken: 'synthetic-team',
    });
  });

  it('does not forward the replaced registry credential or accept project credentials', () => {
    writeFileSync(
      path.join(isolated.home, '.npmrc'),
      `registry=${userRegistry}\n//user.test.qianwenai.com/:_authToken=synthetic-user\n`,
    );
    const project = path.join(root, 'project');
    mkdirSync(project);
    writeFileSync(
      path.join(project, '.npmrc'),
      `registry=${userRegistry}\n//configured.test.qianwenai.com/team/:_authToken=synthetic-project\n`,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(project);

    const resolved = resolveRegistryForPackage(packageName, isolated.home, configuredRegistry);

    expect(resolved.registry).toBe(configuredRegistry);
    expect(resolved.authToken).toBeUndefined();
  });

  it('keeps scope precedence when no override is configured', () => {
    writeFileSync(
      path.join(isolated.home, '.npmrc'),
      `registry=${userRegistry}\n@qianwenai:registry=${configuredRegistry}\n`,
    );
    expect(resolveRegistryForPackage(packageName, isolated.home).registry).toBe(configuredRegistry);
    expect(resolveRegistryForPackage('unscoped', isolated.home).registry).toBe(userRegistry);
  });

  it.each(['automatic prepare', 'explicit install'])(
    '%s actually downloads this default from its configured registry',
    async (operation) => {
      providePackage();
      providePackage('9.9.9');

      const result =
        operation === 'automatic prepare'
          ? await ensureDefaultPlugin(definition(), context())
          : await installManagedPlugin(`${packageName}@1.2.3`, context());

      expect(result.version).toBe('1.2.3');
      expect(requestedUrls()).toHaveLength(2);
      expect(requestedUrls()[0].startsWith(configuredRegistry)).toBe(true);
      expect(requestedUrls().every((url) => !url.startsWith(userRegistry))).toBe(true);
      const installed = readPluginPackageManifest(
        path.join(pluginsDir, 'node_modules', packageName),
      );
      expect(installed?.subcommands).toEqual(packageManifest.subcommands);
    },
  );
});

describe('the configured version is the minimum automatically prepared version', () => {
  it.each(['npm', 'local', 'archive'] as const)(
    'upgrades a usable lower %s installation to the exact default version',
    async (source) => {
      seedInstalled('1.0.0', source);
      providePackage();
      providePackage('9.9.9');

      const result = await ensureDefaultPlugin(definition(), context());

      expect(result.version).toBe('1.2.3');
      expect(readInstalledManifest(manifestPath).plugins[0].version).toBe('1.2.3');
      expect(requestedUrls()).toHaveLength(2);
      expect(
        JSON.parse(
          readFileSync(path.join(pluginsDir, 'node_modules', packageName, 'package.json'), 'utf8'),
        ).version,
      ).toBe('1.2.3');
    },
  );

  it.each([
    ['npm', '1.2.3', '1.2.3'],
    ['npm', '2.0.0', '1.2.3'],
    ['npm', '1.2.3+user.build', '1.2.3'],
    ['npm', '1.2.3', '1.2.3-alpha.2'],
    ['npm', '1.2.3-alpha.10', '1.2.3-alpha.2'],
    ['local', '1.2.3', '1.2.3'],
    ['local', '2.0.0', '1.2.3'],
    ['archive', '1.2.3', '1.2.3'],
    ['archive', '2.0.0', '1.2.3'],
  ] as const)(
    'reuses %s version %s against minimum %s without changing bytes or mtimes',
    async (source, installedVersion, minimum) => {
      const directory = seedInstalled(installedVersion, source);
      const configured = definition({ version: minimum });
      for (const file of [
        manifestPath,
        path.join(directory, 'package.json'),
        path.join(directory, 'index.mjs'),
      ]) {
        utimesSync(file, new Date('2020-01-02T00:00:00Z'), new Date('2020-01-02T00:00:00Z'));
      }
      const before = snapshot(directory);

      const result = await ensureDefaultPlugin(configured, context(configured));

      expect(result.version).toBe(installedVersion);
      expect(result.source).toBe(source);
      expect(snapshot(directory)).toEqual(before);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['1.2.3-alpha.2', '1.2.3-alpha.10'],
    ['1.2.3-alpha.10', '1.2.3'],
  ])('upgrades %s to %s using SemVer prerelease ordering', async (installedVersion, minimum) => {
    seedInstalled(installedVersion);
    providePackage(minimum);
    const configured = definition({ version: minimum });

    expect((await ensureDefaultPlugin(configured, context(configured))).version).toBe(minimum);
    expect(requestedUrls()).toHaveLength(2);
  });

  it.each(['1.0.0', '5.0.0'])(
    'reports CLI incompatibility for existing %s without downloading or replacing it',
    async (version) => {
      const directory = seedInstalled(version, 'npm', {
        ...packageManifest,
        minCliVersion: '99.0.0',
      });
      const before = snapshot(directory);
      providePackage();

      await expect(ensureDefaultPlugin(definition(), context())).rejects.toMatchObject({
        code: 'PLUGIN_CLI_INCOMPATIBLE',
        exitCode: 4,
      });

      expect(snapshot(directory)).toEqual(before);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['disabledDefaults', 'enabled false'])(
    'does not reinstall or upgrade an explicitly disabled default: %s',
    async (kind) => {
      const directory = seedInstalled('1.0.0');
      const manifest = readInstalledManifest(manifestPath);
      if (kind === 'disabledDefaults') manifest.disabledDefaults = [packageName];
      else manifest.plugins[0].enabled = false;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const before = snapshot(directory);
      providePackage();

      await expect(ensureDefaultPlugin(definition(), context())).rejects.toMatchObject({
        code: 'PLUGIN_DEFAULT_DISABLED',
      });

      expect(snapshot(directory)).toEqual(before);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['download failure', 'wrong package identity', 'missing entry'])(
    'preserves the previous package and manifest after a real attempted upgrade: %s',
    async (failure) => {
      const directory = seedInstalled('1.0.0');
      const before = snapshot(directory);
      if (failure === 'download failure')
        fetchMock.mockRejectedValue(new Error('synthetic download failure'));
      else if (failure === 'wrong package identity')
        providePackage('1.2.3', packageManifest, '@qianwenai/wrong-package');
      else providePackage('1.2.3', { ...packageManifest, entry: './missing.mjs' });

      await expect(ensureDefaultPlugin(definition(), context())).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalled();
      expect(snapshot(directory)).toEqual(before);
    },
  );

  it('repairs a missing entry at the minimum version', async () => {
    const directory = seedInstalled('1.2.3');
    rmSync(path.join(directory, 'index.mjs'));
    providePackage();

    expect((await ensureDefaultPlugin(definition(), context())).version).toBe('1.2.3');

    expect(existsSync(path.join(directory, 'index.mjs'))).toBe(true);
    expect(requestedUrls()).toHaveLength(2);
  });

  it('upgrades from an archive entirely offline using its real manifest and verified digest', async () => {
    seedInstalled('1.0.0');
    const bytes = packageBytes('1.2.3');
    writeFileSync(path.join(root, 'default.tgz'), bytes);
    const configured = definition({
      source: { type: 'archive', path: './default.tgz' },
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });

    expect((await ensureDefaultPlugin(configured, context(configured))).version).toBe('1.2.3');

    expect(
      readPluginPackageManifest(path.join(pluginsDir, 'node_modules', packageName))?.subcommands,
    ).toEqual(packageManifest.subcommands);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves a lower version when archive checksum validation fails', async () => {
    const directory = seedInstalled('1.0.0');
    const before = snapshot(directory);
    writeFileSync(path.join(root, 'default.tgz'), packageBytes('1.2.3'));
    const configured = definition({
      source: { type: 'archive', path: './default.tgz' },
      sha256: '0'.repeat(64),
    });

    await expect(ensureDefaultPlugin(configured, context(configured))).rejects.toThrow(
      /sha|digest|checksum|integrity/i,
    );

    expect(snapshot(directory)).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
