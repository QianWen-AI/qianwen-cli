import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { installManagedPlugin } from '../../src/plugins/default-install.js';
import { loadInstalledPlugins, registerPluginCommands } from '../../src/plugins/loader.js';
import { validateManifest, type PluginManifest } from '../../src/plugins/manifest.js';
import { runPluginValidateChecks } from '../../src/plugins/validate.js';
import { directoryState } from '../fixtures/plugin-files.js';
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
vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../plugins.preload.json', () => ({ default: { plugins: [] } }));

const packageName = '@qianwenai/minimum-contract-fixture';
const healthyName = '@qianwenai/healthy-minimum-fixture';
const commandName = 'minimum-fixture';
let warnings: string[];

interface NestedCase {
  label: string;
  depth: number;
  minimum: unknown;
  group?: boolean;
  rootMinimum?: string;
}

const nestedCases: NestedCase[] = [
  { label: 'a satisfied child minimum', depth: 1, minimum: '0.0.1' },
  { label: 'an incompatible child minimum', depth: 1, minimum: '99.0.0' },
  { label: 'a null child minimum', depth: 1, minimum: null },
  { label: 'a malformed group minimum', depth: 2, minimum: 'latest', group: true },
  { label: 'an object grandchild minimum', depth: 2, minimum: {} },
  {
    label: 'a deep blank minimum below a valid root minimum',
    depth: 4,
    minimum: '',
    rootMinimum: '0.0.1',
  },
];

function rootManifest(minimum?: unknown): Record<string, unknown> {
  return {
    command: commandName,
    entry: './index.mjs',
    ...(minimum === undefined ? {} : { minCliVersion: minimum }),
    subcommands: [{ command: 'run', handlerKey: 'run' }],
  };
}

function nestedManifest(scenario: NestedCase): Record<string, unknown> {
  const leaf = { command: 'nested-leaf', handlerKey: 'run' };
  let node: Record<string, unknown> = scenario.group
    ? {
        command: 'nested-group',
        minCliVersion: scenario.minimum,
        subcommands: [leaf],
      }
    : { ...leaf, minCliVersion: scenario.minimum };
  for (let depth = scenario.depth - 1; depth > 0; depth--) {
    node = { command: `group-${depth}`, subcommands: [node] };
  }
  return {
    ...rootManifest(scenario.rootMinimum),
    subcommands: [{ command: 'healthy-leaf', handlerKey: 'run' }, node],
  };
}

function context(): Parameters<typeof installManagedPlugin>[1] {
  return {
    pluginsDir: state.pluginsDir,
    manifestPath: state.manifestPath,
    cliVersion: '1.11.0',
    definitions: [],
  };
}

function writePackage(
  directory: string,
  declared: Record<string, unknown>,
  name = packageName,
  version = '1.0.0',
): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version, qianwen: declared }),
  );
  fs.writeFileSync(
    path.join(directory, 'index.mjs'),
    `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(state.root, 'entry-imported'))}, 'unexpected');
export const handlers = { run() {} };
`,
  );
  fs.writeFileSync(path.join(directory, 'payload.txt'), version);
  return directory;
}

function expectRootRelocation(message: string): void {
  expect(message).toMatch(/minCliVersion/);
  expect(message).toMatch(/subcommands|nested-leaf|nested-group/);
  expect(message).toMatch(/qianwen\.minCliVersion/);
  expect(message).toMatch(/root|move|top.level/i);
}

function loadFixture(declared: Record<string, unknown>, withHealthySibling = false): Command {
  writePackage(path.join(state.pluginsDir, 'node_modules', packageName), declared);
  const names = [packageName];
  if (withHealthySibling) {
    writePackage(
      path.join(state.pluginsDir, 'node_modules', healthyName),
      { command: 'healthy-minimum', entry: './index.mjs', handlerKey: 'run' },
      healthyName,
    );
    names.push(healthyName);
  }
  fs.writeFileSync(
    state.manifestPath,
    JSON.stringify({
      plugins: names.map((name) => ({
        name,
        version: '1.0.0',
        source: 'local',
        enabled: true,
      })),
    }),
  );
  const program = new Command();
  registerPluginCommands(program, loadInstalledPlugins(state.manifestPath, state.pluginsDir));
  return program;
}

beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(projectTmpdir(), 'root-min-cli-version-'));
  state.pluginsDir = path.join(state.root, 'plugins');
  state.manifestPath = path.join(state.root, 'plugins.json');
  fs.writeFileSync(state.manifestPath, JSON.stringify({ plugins: [] }));
  warnings = [];
  vi.stubEnv('QIANWEN_CONFIG_DIR', state.root);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network is forbidden in root minimum tests');
    }),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    warnings.push(String(chunk));
    return true;
  });
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

describe('minimum CLI versions belong only to the root manifest', () => {
  it.each(nestedCases)('rejects $label during static validation', (scenario) => {
    const declared = nestedManifest(scenario);
    const error = validateManifest(declared as PluginManifest);
    expect(error).not.toBeNull();
    expectRootRelocation(String(error));

    const directory = writePackage(path.join(state.root, 'candidate'), declared);
    const failures = runPluginValidateChecks(directory, new Set(), []).filter(
      (check) => check.status === 'fail',
    );
    expect(failures.length).toBeGreaterThan(0);
    expectRootRelocation(failures.map((check) => check.detail ?? '').join('\n'));
  });

  it.each(nestedCases)(
    'rejects $label during installation and preserves the previous package',
    async (scenario) => {
      await installManagedPlugin(
        writePackage(path.join(state.root, 'previous'), rootManifest()),
        context(),
      );
      const beforeManifest = fs.readFileSync(state.manifestPath, 'utf8');
      const beforeFiles = directoryState(state.pluginsDir);
      const candidate = writePackage(
        path.join(state.root, 'candidate'),
        nestedManifest(scenario),
        packageName,
        '2.0.0',
      );

      const error: unknown = await installManagedPlugin(candidate, context()).catch(
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(Error);
      expectRootRelocation(String(error));
      expect(error).not.toMatchObject({ code: 'PLUGIN_CLI_INCOMPATIBLE' });
      expect(fs.readFileSync(state.manifestPath, 'utf8')).toBe(beforeManifest);
      expect(directoryState(state.pluginsDir)).toEqual(beforeFiles);
      expect(fs.existsSync(`${state.manifestPath}.lock`)).toBe(false);
    },
  );

  it.each(nestedCases)(
    'rejects $label during loading without suppressing a healthy sibling',
    (scenario) => {
      const program = loadFixture(nestedManifest(scenario), true);

      expect(program.commands.map((command) => command.name())).toEqual(['healthy-minimum']);
      expectRootRelocation(warnings.join(''));
      expect(warnings.join('')).toContain(packageName);
    },
  );

  it.each([undefined, '0.0.1', '0.1.0-beta.1'])(
    'preserves an omitted or compatible root minimum %j across validation, install and load',
    async (minimum) => {
      const declared = rootManifest(minimum);
      const candidate = writePackage(path.join(state.root, 'candidate'), declared);
      expect(validateManifest(declared as PluginManifest)).toBeNull();
      expect(
        runPluginValidateChecks(candidate, new Set(), []).every((check) => check.status === 'pass'),
      ).toBe(true);

      const installed = await installManagedPlugin(candidate, context());
      expect(installed.name).toBe(packageName);
      const program = new Command();
      registerPluginCommands(program, loadInstalledPlugins(state.manifestPath, state.pluginsDir));
      expect(program.commands.map((command) => command.name())).toEqual([commandName]);
      expect(program.commands[0].commands.map((command) => command.name())).toEqual(['run']);
      expect(warnings).toEqual([]);
    },
  );

  it.each(['', 'latest', null])(
    'continues to reject an invalid root minimum %j without calling it an incompatibility',
    async (minimum) => {
      const declared = rootManifest(minimum);
      const candidate = writePackage(path.join(state.root, 'candidate'), declared);
      const failures = runPluginValidateChecks(candidate, new Set(), []).filter(
        (check) => check.status === 'fail',
      );
      expect(failures).toContainEqual(
        expect.objectContaining({ name: 'minCliVersion', status: 'fail' }),
      );

      const error: unknown = await installManagedPlugin(candidate, context()).catch(
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/minCliVersion/);
      expect(error).not.toMatchObject({ code: 'PLUGIN_CLI_INCOMPATIBLE' });

      expect(loadFixture(declared).commands).toHaveLength(0);
      expect(warnings.join('')).toMatch(/minCliVersion/);
      expect(warnings.join('')).not.toMatch(/requires CLI|incompatible/i);
    },
  );

  it('preserves structured root incompatibility and skips the complete command tree', async () => {
    const declared = rootManifest('99.0.0');
    const candidate = writePackage(path.join(state.root, 'candidate'), declared);

    await expect(installManagedPlugin(candidate, context())).rejects.toMatchObject({
      code: 'PLUGIN_CLI_INCOMPATIBLE',
      exitCode: 4,
      minCliVersion: '99.0.0',
      currentCliVersion: '1.11.0',
    });
    expect(loadFixture(declared).commands).toHaveLength(0);
    expect(warnings.join('')).toMatch(/requires CLI >= 99\.0\.0/);
  });

  it('also rejects a nested minimum for a required default descriptor before loading handlers', () => {
    const loadHandlers = vi.fn(async () => ({ handlers: { run: vi.fn() } }));
    const declared = nestedManifest(nestedCases[0]);

    expect(() =>
      registerPluginCommands(
        new Command(),
        [
          {
            name: packageName,
            version: '1.0.0',
            manifest: declared as PluginManifest,
            loadHandlers,
          },
        ],
        { trustedDefault: true },
      ),
    ).toThrow(/minCliVersion/);
    expect(loadHandlers).not.toHaveBeenCalled();
  });
});
