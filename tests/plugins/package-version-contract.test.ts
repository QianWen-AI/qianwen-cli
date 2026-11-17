import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDefaultPlugin, installManagedPlugin } from '../../src/plugins/default-install.js';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import { installLocalPlugin, type InstallResult } from '../../src/plugins/installer.js';
import { runPluginValidateChecks } from '../../src/plugins/validate.js';
import { directoryState } from '../fixtures/plugin-files.js';
import { projectTmpdir } from '../fixtures/plugin-temporary-root.js';
import { buildTarball } from '../fixtures/tar-builder.js';

const state = vi.hoisted(() => ({ root: '', pluginsDir: '', manifestPath: '' }));
const registry = vi.hoisted(() => ({
  install: vi.fn<(spec: string, pluginsDir: string) => Promise<InstallResult>>(),
}));
vi.mock('../../src/plugins/installer.js', async (original) => ({
  ...(await original<typeof import('../../src/plugins/installer.js')>()),
  installNpmPlugin: registry.install,
}));
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

const packageName = '@qianwenai/version-contract-fixture';
const manifest = { command: 'version-fixture', entry: './index.mjs', handlerKey: 'run' };
const validVersions = [
  '1.2.3',
  '2.0.0-beta.1',
  '1.1.0+build-with-hyphen',
  '2.0.0-beta.1+build.7',
  '9007199254740993.0.0',
  '1',
  '1.2',
  'v1.2.3',
  ' 1.2.3 ',
];
const invalidVersions: Array<{ label: string; value: unknown }> = [
  { label: 'missing', value: undefined },
  { label: 'null', value: null },
  { label: 'number', value: 123 },
  { label: 'boolean', value: true },
  { label: 'object', value: {} },
  { label: 'array', value: [] },
  { label: 'empty', value: '' },
  { label: 'whitespace', value: ' \t\n' },
  { label: 'tag', value: 'latest' },
  { label: 'range', value: '^1.2.3' },
  { label: 'extra component', value: '1.2.3.4' },
  { label: 'empty prerelease', value: '1.2.3-' },
  { label: 'empty build metadata', value: '1.2.3+' },
];
const invalidInstallVersions = invalidVersions.filter(({ label }) =>
  ['missing', 'null', 'number', 'object', 'empty', 'tag'].includes(label),
);

function context(): Parameters<typeof installManagedPlugin>[1] {
  return {
    pluginsDir: state.pluginsDir,
    manifestPath: state.manifestPath,
    cliVersion: '1.11.0',
    definitions: [],
  };
}

function writePackage(id: string, version: unknown): string {
  const directory = path.join(state.root, 'sources', id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: packageName, version, qianwen: manifest }),
  );
  fs.writeFileSync(
    path.join(directory, 'index.mjs'),
    `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(state.root, 'entry-imported'))}, 'unexpected');
export const handlers = { run() {} };
`,
  );
  fs.writeFileSync(path.join(directory, 'payload.txt'), id);
  return directory;
}

async function previousInstallation(version = '1.0.0') {
  await installManagedPlugin(writePackage('previous', version), context());
  return {
    manifest: fs.readFileSync(state.manifestPath, 'utf8'),
    files: directoryState(state.pluginsDir),
  };
}

function expectUnchanged(before: Awaited<ReturnType<typeof previousInstallation>>): void {
  expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(before.manifest);
  expect(directoryState(state.pluginsDir)).toEqual(before.files);
  expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
}

function archiveDefinition(version: unknown): DefaultPlugin {
  const source = writePackage('archive-candidate', version);
  const tarball = buildTarball(
    ['package.json', 'index.mjs', 'payload.txt'].map((file) => ({
      name: `package/${file}`,
      data: fs.readFileSync(path.join(source, file)),
    })),
  );
  const archive = path.join(state.root, 'candidate.tgz');
  fs.writeFileSync(archive, tarball);
  return {
    name: packageName,
    version: '1.0.0',
    command: manifest.command,
    source: { type: 'archive', path: archive },
    sha256: createHash('sha256').update(tarball).digest('hex'),
  };
}

beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(projectTmpdir(), 'package-version-contract-'));
  state.pluginsDir = path.join(state.root, 'plugins');
  state.manifestPath = path.join(state.root, 'plugins.json');
  fs.writeFileSync(state.manifestPath, JSON.stringify({ plugins: [] }));
  registry.install.mockReset();
  vi.stubEnv('QIANWEN_CONFIG_DIR', state.root);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network is forbidden in package version tests');
    }),
  );
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(state.root, 'entry-imported'))).toBe(false);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

describe('package version static validation', () => {
  it.each(invalidVersions)(
    'reports a dedicated failure for $label package.version',
    ({ value }) => {
      const directory = writePackage('invalid', value);
      const checks = runPluginValidateChecks(directory, new Set(), []);

      expect(checks).toContainEqual(
        expect.objectContaining({
          name: 'version',
          status: 'fail',
          detail: expect.stringMatching(/package\.version/i),
        }),
      );
      expect(checks.find((check) => check.name === 'package.json')?.status).toBe('pass');
    },
  );

  it.each(validVersions)('preserves existing valid package.version syntax %j', (version) => {
    const directory = writePackage('valid', version);
    const checks = runPluginValidateChecks(directory, new Set(), []);

    expect(checks).toContainEqual(expect.objectContaining({ name: 'version', status: 'pass' }));
    expect(checks.every((check) => check.status === 'pass')).toBe(true);
  });
});

describe('package version installation diagnostics and replacement safety', () => {
  it.each(['latest', null])(
    'reports invalid archive package.version %j before a configured version mismatch',
    async (version) => {
      const before = await previousInstallation('0.5.0');
      const configured = archiveDefinition(version);

      const error: unknown = await ensureDefaultPlugin(configured, {
        ...context(),
        definitions: [configured],
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/package\.version/i);
      expect(String(error)).toMatch(/invalid/i);
      expect(String(error)).not.toMatch(/(?:mismatch|does not match).*(?:configured|expected)/i);
      expect(String(error)).not.toMatch(/(?:configured|expected).*(?:mismatch|does not match)/i);
      expect(registry.install).not.toHaveBeenCalled();
      expectUnchanged(before);
    },
  );

  it('keeps a valid archive version disagreement distinct from invalid package.version', async () => {
    const before = await previousInstallation('0.5.0');
    const configured = archiveDefinition('2.0.0');

    const error: unknown = await ensureDefaultPlugin(configured, {
      ...context(),
      definitions: [configured],
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/version/i);
    expect(String(error)).toMatch(/configured|expected/i);
    expect(String(error)).toMatch(/mismatch|does not match/i);
    expect(String(error)).not.toMatch(/invalid.*package\.version|package\.version.*invalid/i);
    expect(registry.install).not.toHaveBeenCalled();
    expectUnchanged(before);
  });

  it.each(invalidInstallVersions)(
    'identifies $label package.version and preserves the previous installation',
    async ({ value }) => {
      const before = await previousInstallation();
      const candidate = writePackage('candidate', value);
      const error: unknown = await installManagedPlugin(candidate, context()).catch(
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/package\.version/i);
      expect(String(error)).toMatch(/invalid/i);
      expect(String(error)).not.toMatch(/metadata mismatch|does not match.*metadata/i);
      expectUnchanged(before);
    },
  );

  it('distinguishes valid package metadata disagreement from an invalid version', async () => {
    const before = await previousInstallation();
    const candidate = writePackage('candidate', '2.0.1');
    registry.install.mockImplementation(async (_spec, pluginsDir) => {
      const result = installLocalPlugin(candidate, pluginsDir, { recoverable: true });
      if (!result.ok) return result;
      return { ok: true, tx: { ...result.tx, version: '2.0.0' } };
    });

    const error: unknown = await installManagedPlugin(`${packageName}@2.0.0`, context()).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/metadata mismatch|does not match.*metadata/i);
    expect(String(error)).not.toMatch(/invalid.*package\.version|package\.version.*invalid/i);
    expect(registry.install).toHaveBeenCalledOnce();
    expectUnchanged(before);
  });

  it.each(validVersions)('installs an explicitly chosen local version %j', async (version) => {
    const candidate = writePackage('candidate', version);
    const installed = await installManagedPlugin(candidate, context());
    const destination = path.join(state.pluginsDir, 'node_modules', packageName);

    expect(installed.name).toBe(packageName);
    expect(installed.version).toEqual(expect.any(String));
    expect(JSON.parse(fs.readFileSync(state.manifestPath, 'utf8')).plugins).toContainEqual(
      expect.objectContaining({ name: packageName, version: installed.version }),
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8')).version,
    ).toBe(version);
    expect(fs.readFileSync(path.join(destination, 'payload.txt'), 'utf8')).toBe('candidate');
  });
});
