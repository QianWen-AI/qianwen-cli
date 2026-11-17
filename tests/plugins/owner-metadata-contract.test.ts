import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findConfiguredOpenApiPolicy,
  getConfiguredOpenApiRules,
  type OpenApiPolicyRule,
} from '../../src/config/openapi-policy.js';
import { installManagedPlugin } from '../../src/plugins/default-install.js';
import { installLocalPlugin, type InstallTransaction } from '../../src/plugins/installer.js';
import { loadInstalledPlugins } from '../../src/plugins/loader.js';
import type { InstalledManifest, PluginManifest } from '../../src/plugins/manifest.js';
import {
  directoryState,
  writeInstalledPlugins,
  writePluginPackage,
} from '../fixtures/plugin-files.js';
import { projectTmpdir } from '../fixtures/plugin-temporary-root.js';

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

type InstalledPlugin = InstalledManifest['plugins'][number];
type ManagedSource = 'npm' | 'local' | 'archive';
type MissingField = 'command' | 'commandAliases';
type MetadataLink = 'external' | 'dangling' | 'sibling' | 'intermediate';

const ownerName = '@qianwenai/owner-fixture';
const healthyName = '@qianwenai/healthy-owner-fixture';
const healthyCommand = 'healthy-owner';
const healthyPolicy: OpenApiPolicyRule = {
  product: 'OwnerMetadataPortal',
  actions: ['ReadHealthy'],
  auth: 'required',
};
const candidatePolicy: OpenApiPolicyRule = {
  product: 'OwnerMetadataPortal',
  actions: ['ReadCandidate'],
  auth: 'optional',
};

function context(): Parameters<typeof installManagedPlugin>[1] {
  return {
    pluginsDir: state.pluginsDir,
    manifestPath: state.manifestPath,
    cliVersion: '1.11.0',
    definitions: [],
  };
}

function destination(name = ownerName): string {
  return path.join(state.pluginsDir, 'node_modules', name);
}

function manifest(command: string, changes: Partial<PluginManifest> = {}): PluginManifest {
  return { command, entry: './index.mjs', handlerKey: 'run', auth: 'optional', ...changes };
}

function packageAt(directory: string, name: string, metadata: PluginManifest): string {
  return writePluginPackage(
    directory,
    name,
    '1.0.0',
    metadata,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(state.root, 'handler-imported'))}, 'unexpected');
export const handlers = { run() {} };`,
  );
}

function record(
  name: string,
  source: InstalledPlugin['source'] = 'local',
  changes: Partial<InstalledPlugin> = {},
): InstalledPlugin {
  return { name, version: '1.0.0', enabled: true, source, ...changes };
}

function installed(): InstalledManifest {
  return JSON.parse(fs.readFileSync(state.manifestPath, 'utf8')) as InstalledManifest;
}

function installCandidate(command: string): Promise<InstalledPlugin> {
  const name = '@qianwenai/new-owner-fixture';
  const source = packageAt(path.join(state.root, 'candidate'), name, manifest(command));
  return installManagedPlugin(source, context());
}

function seedHealthy(owner: InstalledPlugin): void {
  packageAt(
    destination(healthyName),
    healthyName,
    manifest(healthyCommand, { apiPolicy: [healthyPolicy] }),
  );
  writeInstalledPlugins(state.manifestPath, [
    owner,
    record(healthyName, 'local', { command: healthyCommand }),
  ]);
}

function linkedMetadata(kind: MetadataLink, metadata: PluginManifest): string[] {
  const directory = destination();
  packageAt(directory, ownerName, manifest('discarded'));
  const metadataPath = path.join(directory, 'package.json');
  fs.unlinkSync(metadataPath);
  const externalDirectory =
    kind === 'sibling' ? `${directory}-sibling` : path.join(state.root, 'external-metadata');
  const externalMetadata = path.join(externalDirectory, 'package.json');
  if (kind !== 'dangling') packageAt(externalDirectory, ownerName, metadata);
  if (kind === 'intermediate') {
    fs.symlinkSync(externalDirectory, path.join(directory, 'metadata'), 'dir');
    fs.symlinkSync('./metadata/package.json', metadataPath, 'file');
  } else fs.symlinkSync(externalMetadata, metadataPath, 'file');
  return [metadataPath, externalMetadata, path.join(directory, 'metadata', 'package.json')];
}

function expectHealthyPolicy(): void {
  expect.soft(getConfiguredOpenApiRules()).toContainEqual(healthyPolicy);
  expect
    .soft(findConfiguredOpenApiPolicy(healthyPolicy.product, healthyPolicy.actions[0]))
    .toEqual(healthyPolicy);
}

beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(projectTmpdir(), 'owner-metadata-contract-'));
  state.pluginsDir = path.join(state.root, 'plugins');
  state.manifestPath = path.join(state.root, 'plugins.json');
  writeInstalledPlugins(state.manifestPath, []);
  vi.stubEnv('QIANWEN_CONFIG_DIR', state.root);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Owner metadata inspection must not access the network');
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

async function expectUntrustedMetadataIgnored(
  source: ManagedSource,
  missing: MissingField,
  kind: MetadataLink,
): Promise<void> {
  const claimedCommand = missing === 'command' ? 'untrusted-command' : 'untrusted-alias';
  const deniedPaths = linkedMetadata(
    kind,
    manifest('untrusted-command', { commandAliases: ['untrusted-alias', healthyCommand] }),
  );
  const owner = record(ownerName, source, {
    ...(missing === 'command' ? { commandAliases: ['saved-alias'] } : { command: 'saved-command' }),
  });
  seedHealthy(owner);
  const read = vi.spyOn(fs, 'readFileSync');
  const open = vi.spyOn(fs, 'openSync');

  expectHealthyPolicy();
  const result = await installCandidate(claimedCommand).then(
    (plugin) => ({ plugin }),
    (error: unknown) => ({ error }),
  );

  expect.soft(result).toMatchObject({ plugin: { command: claimedCommand } });
  expect(installed().plugins.find((plugin) => plugin.name === ownerName)).toEqual(owner);
  for (const file of deniedPaths) {
    expect.soft(read.mock.calls.map(([candidate]) => String(candidate))).not.toContain(file);
    expect.soft(open.mock.calls.map(([candidate]) => String(candidate))).not.toContain(file);
  }
}

describe.each(['npm', 'local', 'archive'] as const)('managed %s owner metadata', (source) => {
  it.each([
    { missing: 'command' as const, kind: 'external' as const },
    { missing: 'commandAliases' as const, kind: 'external' as const },
    { missing: 'command' as const, kind: 'dangling' as const },
    { missing: 'commandAliases' as const, kind: 'dangling' as const },
  ])(
    'does not read or reserve $kind metadata while filling missing $missing',
    async ({ missing, kind }) => {
      await expectUntrustedMetadataIgnored(source, missing, kind);
    },
  );

  it.each(['command', 'commandAliases'] as const)(
    'retains the recorded %s reservation when the remaining metadata is untrusted',
    async (preserved) => {
      linkedMetadata('external', manifest('untrusted-command', { commandAliases: ['untrusted'] }));
      const owner = record(ownerName, source, {
        ...(preserved === 'command'
          ? { command: 'committed-reservation' }
          : { commandAliases: ['committed-reservation'] }),
      });
      seedHealthy(owner);
      const before = fs.readFileSync(state.manifestPath, 'utf8');

      await expect(installCandidate('committed-reservation')).rejects.toThrow();

      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
      expectHealthyPolicy();
    },
  );
});

describe('legacy owner metadata compatibility', () => {
  it.each(['sibling', 'intermediate'] as const)(
    'rejects missing aliases obtained through a %s metadata link',
    async (kind) => {
      await expectUntrustedMetadataIgnored('npm', 'commandAliases', kind);
    },
  );

  it.each(['npm', 'local', 'archive'] as const)(
    'fills valid legacy %s commands and aliases without recursive owner validation',
    async (source) => {
      packageAt(
        destination(),
        ownerName,
        manifest('legacy-owner', { commandAliases: ['legacy-alias'] }),
      );
      seedHealthy(record(ownerName, source));
      const healthy = installed().plugins.find((plugin) => plugin.name === healthyName);
      if (!healthy) throw new Error('Missing healthy record');
      delete healthy.command;
      writeInstalledPlugins(state.manifestPath, [record(ownerName, source), healthy]);
      const before = fs.readFileSync(state.manifestPath, 'utf8');

      expectHealthyPolicy();
      await expect(installCandidate('legacy-alias')).rejects.toThrow();
      await expect(installCandidate('legacy-owner')).rejects.toThrow();

      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
      expectHealthyPolicy();
    },
  );

  it('fills aliases through a package.json link contained in the actual package directory', async () => {
    packageAt(
      destination(),
      ownerName,
      manifest('legacy-owner', { commandAliases: ['legacy-alias'] }),
    );
    fs.mkdirSync(path.join(destination(), 'metadata'));
    fs.renameSync(
      path.join(destination(), 'package.json'),
      path.join(destination(), 'metadata', 'package.json'),
    );
    fs.symlinkSync('./metadata/package.json', path.join(destination(), 'package.json'), 'file');
    seedHealthy(record(ownerName, 'npm', { command: 'legacy-owner' }));

    expectHealthyPolicy();
    await expect(installCandidate('legacy-alias')).rejects.toThrow();
  });

  it.each(['link', 'bundle'] as const)(
    'loads an external %s development package and preserves its recorded reservations',
    async (source) => {
      const directory = packageAt(
        path.join(state.root, 'development-package'),
        ownerName,
        manifest('development-owner', { commandAliases: ['development-alias'] }),
      );
      seedHealthy(
        record(ownerName, source, {
          path: directory,
          command: 'development-owner',
          commandAliases: ['development-alias'],
        }),
      );

      expect(
        loadInstalledPlugins(state.manifestPath, state.pluginsDir).map((plugin) => plugin.name),
      ).toContain(ownerName);
      await expect(installCandidate('development-alias')).rejects.toThrow();
      await expect(installCandidate('development-owner')).rejects.toThrow();
    },
  );
});

async function seedCommittedPair(source: ManagedSource = 'local'): Promise<string> {
  await installManagedPlugin(
    packageAt(path.join(state.root, 'old-owner'), ownerName, manifest('committed-owner')),
    context(),
  );
  await installManagedPlugin(
    packageAt(
      path.join(state.root, 'old-healthy'),
      healthyName,
      manifest(healthyCommand, { apiPolicy: [healthyPolicy] }),
    ),
    context(),
  );
  const committed = installed();
  const owner = committed.plugins.find((plugin) => plugin.name === ownerName);
  if (!owner) throw new Error('Missing owner record');
  expect(owner).not.toHaveProperty('commandAliases');
  owner.source = source;
  writeInstalledPlugins(state.manifestPath, committed.plugins);
  expectHealthyPolicy();
  return fs.readFileSync(state.manifestPath, 'utf8');
}

function replacement(): string {
  return packageAt(
    path.join(state.root, 'replacement'),
    ownerName,
    manifest('committed-owner', {
      commandAliases: [healthyCommand],
      apiPolicy: [candidatePolicy],
    }),
  );
}

function beginReplacement(candidate: string): InstallTransaction {
  const result = installLocalPlugin(candidate, state.pluginsDir, { recoverable: true });
  if (!result.ok) throw new Error(result.error);
  return result.tx;
}

describe('uncommitted owner metadata cannot suppress committed API policy', () => {
  it.each(['npm', 'local', 'archive'] as const)(
    'keeps healthy policy visible during and after a same-version pending %s alias change',
    async (source) => {
      const before = await seedCommittedPair(source);
      const transaction = beginReplacement(replacement());
      const pendingFiles = directoryState(state.pluginsDir);
      try {
        expectHealthyPolicy();
        expect(getConfiguredOpenApiRules()).not.toContainEqual(candidatePolicy);
        expect(directoryState(state.pluginsDir)).toEqual(pendingFiles);
        expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
        expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
      } finally {
        transaction.rollback();
      }

      expectHealthyPolicy();
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
    },
  );

  it.each(['command', 'commandAliases'] as const)(
    'retains a committed %s reservation while a replacement is pending',
    async (preserved) => {
      await seedCommittedPair();
      const committed = installed();
      const owner = committed.plugins.find((plugin) => plugin.name === ownerName);
      if (!owner) throw new Error('Missing owner record');
      if (preserved === 'command') owner.command = healthyCommand;
      else {
        delete owner.command;
        owner.commandAliases = [healthyCommand];
      }
      writeInstalledPlugins(state.manifestPath, committed.plugins);
      const transaction = beginReplacement(replacement());
      const before = directoryState(state.root);
      try {
        expect(getConfiguredOpenApiRules()).not.toContainEqual(healthyPolicy);
        expect(directoryState(state.root)).toEqual(before);
      } finally {
        transaction.rollback();
      }
    },
  );

  it.each([
    { reader: 'rules', rollback: false },
    { reader: 'rules', rollback: true },
    { reader: 'lookup', rollback: false },
    { reader: 'lookup', rollback: true },
  ] as const)(
    'rejects candidate ownership when replacement starts during $reader reading (rollback=$rollback)',
    async ({ reader, rollback }) => {
      await seedCommittedPair();
      writeInstalledPlugins(state.manifestPath, [...installed().plugins].reverse());
      const before = fs.readFileSync(state.manifestPath, 'utf8');
      const candidate = replacement();
      const packagePath = path.join(destination(), 'package.json');
      const read = fs.readFileSync;
      const open = fs.openSync;
      let interleaved = false;
      let fixtureWriter = false;
      let transaction: InstallTransaction | undefined;
      let expectedFiles: ReturnType<typeof directoryState> | undefined;
      const readerMutations: string[] = [];
      const begin = () => {
        interleaved = true;
        fixtureWriter = true;
        transaction = beginReplacement(candidate);
      };
      const finish = () => {
        if (rollback) {
          transaction?.rollback();
          transaction = undefined;
        }
        expectedFiles = directoryState(state.pluginsDir);
        fixtureWriter = false;
      };
      for (const method of [
        'writeFileSync',
        'mkdirSync',
        'renameSync',
        'rmSync',
        'unlinkSync',
      ] as const) {
        const original = fs[method];
        vi.spyOn(fs, method).mockImplementation((...args: unknown[]) => {
          if (!fixtureWriter) readerMutations.push(method);
          return Reflect.apply(original, fs, args);
        });
      }
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
          begin();
          const descriptor = open(file, flags, mode);
          finish();
          return descriptor;
        }
        return open(file, flags, mode);
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
        if (!interleaved && String(args[0]) === packagePath) {
          begin();
          const bytes: unknown = Reflect.apply(read, fs, args);
          finish();
          return bytes;
        }
        return Reflect.apply(read, fs, args);
      }) as typeof fs.readFileSync);

      try {
        const result =
          reader === 'rules'
            ? getConfiguredOpenApiRules()
            : findConfiguredOpenApiPolicy(healthyPolicy.product, healthyPolicy.actions[0]);

        expect(interleaved).toBe(true);
        if (reader === 'rules') {
          expect.soft(result).toContainEqual(healthyPolicy);
          expect.soft(result).not.toContainEqual(candidatePolicy);
        } else expect.soft(result).toEqual(healthyPolicy);
        expect(directoryState(state.pluginsDir)).toEqual(expectedFiles);
        expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
        expect(readerMutations).toEqual([]);
        expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
      } finally {
        vi.restoreAllMocks();
        transaction?.rollback();
      }

      expectHealthyPolicy();
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
    },
  );
});

const managedDevelopmentCases = [
  { source: 'link', pathKind: 'omitted', preserved: 'command' },
  { source: 'link', pathKind: 'explicit', preserved: 'commandAliases' },
  { source: 'bundle', pathKind: 'omitted', preserved: 'commandAliases' },
  { source: 'bundle', pathKind: 'explicit', preserved: 'command' },
] as const;

describe('managed-root development owner metadata', () => {
  it.each(managedDevelopmentCases)(
    'fills committed $source commands and aliases with $pathKind managed path',
    async ({ source, pathKind }) => {
      packageAt(
        destination(),
        ownerName,
        manifest('managed-legacy-owner', { commandAliases: ['managed-legacy-alias'] }),
      );
      seedHealthy(
        record(ownerName, source, {
          ...(pathKind === 'explicit' ? { path: destination() } : {}),
        }),
      );
      const before = fs.readFileSync(state.manifestPath, 'utf8');

      expect(
        loadInstalledPlugins(state.manifestPath, state.pluginsDir).map((plugin) => plugin.name),
      ).toContain(ownerName);
      expectHealthyPolicy();
      for (const command of ['managed-legacy-owner', 'managed-legacy-alias']) {
        const result = await installCandidate(command).then(
          (plugin) => ({ plugin }),
          (error: unknown) => ({ error }),
        );
        expect.soft(result).toMatchObject({
          error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining(command) },
        });
      }

      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
      expectHealthyPolicy();
    },
  );

  it.each(managedDevelopmentCases)(
    'rejects escaped $source supplements with $pathKind managed path while retaining $preserved',
    async ({ source, pathKind, preserved }) => {
      const deniedPaths = linkedMetadata(
        'external',
        manifest('untrusted-command', { commandAliases: ['untrusted-alias'] }),
      );
      const owner = record(ownerName, source, {
        ...(pathKind === 'explicit' ? { path: destination() } : {}),
        ...(preserved === 'command'
          ? { command: 'saved-reservation' }
          : { commandAliases: ['saved-reservation'] }),
      });
      seedHealthy(owner);
      const read = vi.spyOn(fs, 'readFileSync');
      const open = vi.spyOn(fs, 'openSync');
      const untrusted = preserved === 'command' ? 'untrusted-alias' : 'untrusted-command';

      await expect(installCandidate(untrusted)).resolves.toMatchObject({ command: untrusted });
      const beforeConflict = fs.readFileSync(state.manifestPath, 'utf8');
      await expect(installCandidate('saved-reservation')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('saved-reservation'),
      });

      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(beforeConflict);
      expect(installed().plugins.find((plugin) => plugin.name === ownerName)).toEqual(owner);
      for (const file of deniedPaths) {
        expect.soft(read.mock.calls.map(([candidate]) => String(candidate))).not.toContain(file);
        expect.soft(open.mock.calls.map(([candidate]) => String(candidate))).not.toContain(file);
      }
    },
  );

  it.each(managedDevelopmentCases)(
    'ignores pending $source supplements with $pathKind managed path while retaining $preserved',
    ({ source, pathKind, preserved }) => {
      packageAt(destination(), ownerName, manifest('committed-owner'));
      const owner = record(ownerName, source, {
        ...(pathKind === 'explicit' ? { path: destination() } : {}),
        ...(preserved === 'command'
          ? { command: 'committed-owner' }
          : { commandAliases: ['committed-owner'] }),
      });
      seedHealthy(owner);
      const conflictingName = '@qianwenai/reservation-conflict-fixture';
      const conflictingPolicy: OpenApiPolicyRule = {
        product: healthyPolicy.product,
        actions: ['ReadReservationConflict'],
        auth: 'optional',
      };
      packageAt(
        destination(conflictingName),
        conflictingName,
        manifest('committed-owner', { apiPolicy: [conflictingPolicy] }),
      );
      writeInstalledPlugins(state.manifestPath, [
        ...installed().plugins,
        record(conflictingName, 'local', { command: 'committed-owner' }),
      ]);
      expectHealthyPolicy();
      const before = fs.readFileSync(state.manifestPath, 'utf8');
      const transaction = beginReplacement(replacement());
      const pendingFiles = directoryState(state.pluginsDir);

      try {
        expectHealthyPolicy();
        const rules = getConfiguredOpenApiRules();
        expect.soft(rules).not.toContainEqual(candidatePolicy);
        expect.soft(rules).not.toContainEqual(conflictingPolicy);
        expect(directoryState(state.pluginsDir)).toEqual(pendingFiles);
        expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
        expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
      } finally {
        transaction.rollback();
      }

      expectHealthyPolicy();
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before);
    },
  );
});
