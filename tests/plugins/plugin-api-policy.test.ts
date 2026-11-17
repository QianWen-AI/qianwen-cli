import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  findConfiguredOpenApiPolicy,
  getConfiguredOpenApiRules,
  type OpenApiPolicyRule,
} from '../../src/config/openapi-policy.js';
import {
  readPluginPackageManifest,
  validateManifest,
  type InstalledPlugin,
} from '../../src/plugins/manifest.js';

const isolated = vi.hoisted(() => ({ root: '', pluginsDir: '', manifestPath: '' }));
vi.mock('../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../src/config/paths.js')>()),
  getConfigDir: () => isolated.root,
  getPluginsDir: () => isolated.pluginsDir,
  getPluginsManifestPath: () => isolated.manifestPath,
}));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => isolated.root;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../plugins.preload.json', () => ({ default: { plugins: [] } }));

const firstName = '@qianwenai/policy-one';
const secondName = '@qianwenai/policy-two';
let marker: string;

function rule(overrides: Partial<OpenApiPolicyRule> = {}): OpenApiPolicyRule {
  return { product: 'TestPortal', actions: ['ReadEntry'], auth: 'optional', ...overrides };
}

function manifest(
  apiPolicy: unknown = [rule()],
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    command: 'policy-one',
    entry: './index.mjs',
    handlerKey: 'run',
    auth: 'optional',
    minCliVersion: '1.0.0',
    ...(apiPolicy === undefined ? {} : { apiPolicy }),
    ...changes,
  };
}

function fixture(
  name = firstName,
  apiPolicy: unknown = [rule()],
  changes: Record<string, unknown> = {},
): { directory: string; record: InstalledPlugin } {
  const command = name.slice(name.lastIndexOf('/') + 1);
  const directory = path.join(isolated.pluginsDir, 'node_modules', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      main: './index.mjs',
      qianwen: manifest(apiPolicy, { command, ...changes }),
    }),
  );
  writeFileSync(
    path.join(directory, 'index.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'entry imported');`,
      'export const handlers = { run() {} };',
    ].join('\n'),
  );
  return {
    directory,
    record: { name, version: '1.0.0', source: 'npm', enabled: true, command },
  };
}

function installed(records: InstalledPlugin[], disabledDefaults?: string[]): void {
  writeFileSync(
    isolated.manifestPath,
    JSON.stringify({ plugins: records, ...(disabledDefaults ? { disabledDefaults } : {}) }),
  );
}

function snapshot(directory: string): Record<string, { bytes: string; mtimeMs: number }> {
  return Object.fromEntries(
    [
      isolated.manifestPath,
      path.join(directory, 'package.json'),
      path.join(directory, 'index.mjs'),
    ].map((file) => [file, { bytes: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs }]),
  );
}

function attempt<T>(operation: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectClosed(product = 'TestPortal', action = 'ReadEntry'): void {
  const rules = attempt(getConfiguredOpenApiRules);
  if (rules.ok) {
    expect(
      rules.value.filter((item) => item.product === product && item.actions.includes(action)),
    ).toEqual([]);
  } else {
    expect(rules.error).toBeInstanceOf(Error);
  }
  const found = attempt(() => findConfiguredOpenApiPolicy(product, action));
  if (found.ok) expect(found.value).toBeUndefined();
  else expect(found.error).toBeInstanceOf(Error);
}

beforeEach(() => {
  const temporaryRoot = path.resolve(__dirname, '../../.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  isolated.root = mkdtempSync(path.join(temporaryRoot, 'plugin-api-policy-'));
  isolated.pluginsDir = path.join(isolated.root, 'plugins');
  isolated.manifestPath = path.join(isolated.root, 'plugins.json');
  marker = path.join(isolated.root, 'entry-imported');
  vi.stubEnv('QIANWEN_CONFIG_DIR', isolated.root);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Reading installed policy must not make network requests');
    }),
  );
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(isolated.root, { recursive: true, force: true });
  }
});

describe('qianwen.apiPolicy has an explicit, strictly validated shape', () => {
  it.each(
    [
      [],
      [rule()],
      [rule({ auth: 'required', response: 'success-code-envelope' })],
      [rule({ product: 'FuturePortal', actions: ['FutureOperation'] })],
    ].map((apiPolicy) => ({ apiPolicy })),
  )(
    'accepts independently declared policy without a host allowlist: $apiPolicy',
    ({ apiPolicy }) => {
      const { directory } = fixture(firstName, apiPolicy);
      const parsed = readPluginPackageManifest(directory);

      expect(parsed).toMatchObject({ apiPolicy });
      expect(parsed && validateManifest(parsed)).toBeNull();
    },
  );

  it.each(
    [
      null,
      {},
      'optional',
      [null],
      [{ actions: ['ReadEntry'], auth: 'optional' }],
      [{ ...rule(), product: '' }],
      [{ ...rule(), product: '   ' }],
      [{ ...rule(), product: 7 }],
      [{ ...rule(), actions: 'ReadEntry' }],
      [{ ...rule(), actions: [] }],
      [{ ...rule(), actions: [''] }],
      [{ ...rule(), actions: ['   '] }],
      [{ ...rule(), actions: [7] }],
      [{ product: 'TestPortal', actions: ['ReadEntry'] }],
      [{ ...rule(), auth: 'none' }],
      [{ ...rule(), response: null }],
      [{ ...rule(), response: 'unknown-envelope' }],
      [{ ...rule(), response: ['success-code-envelope'] }],
      [{ ...rule(), endpoint: 'https://override.test.qianwenai.com/' }],
    ].map((apiPolicy) => ({ apiPolicy })),
  )(
    'rejects malformed apiPolicy metadata before granting any rule: $apiPolicy',
    ({ apiPolicy }) => {
      const { directory, record } = fixture(firstName, apiPolicy);
      installed([record]);
      const parsed = readPluginPackageManifest(directory);

      expect(parsed === null || validateManifest(parsed) !== null).toBe(true);
      expectClosed();
    },
  );

  it('rejects contradictory overlapping rules inside one plugin manifest', () => {
    const { directory, record } = fixture(firstName, [
      rule({ actions: ['ReadEntry', 'ListEntries'] }),
      rule({ actions: ['ListEntries', 'PrivateEntry'], auth: 'required' }),
    ]);
    installed([record]);
    const parsed = readPluginPackageManifest(directory);

    expect(parsed === null || validateManifest(parsed) !== null).toBe(true);
    expectClosed('TestPortal', 'ListEntries');
  });
});

describe('policy is derived from current installed metadata', () => {
  it('has no rules without an installed record, even if a package is present on disk', () => {
    expect(getConfiguredOpenApiRules()).toEqual([]);
    fixture();

    expect(getConfiguredOpenApiRules()).toEqual([]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toBeUndefined();
    expect(existsSync(isolated.manifestPath)).toBe(false);
  });

  it.each(['npm', 'local', 'archive'] as const)(
    'reads valid enabled %s metadata without importing or rewriting its managed package',
    (source) => {
      const policy = [
        rule({ actions: ['ReadEntry', 'ListEntries'], response: 'success-code-envelope' }),
        rule({ product: 'OtherPortal', actions: ['CreateEntry'], auth: 'required' }),
      ];
      const { directory, record } = fixture(firstName, policy);
      installed([{ ...record, source }]);
      const before = snapshot(directory);

      expect(getConfiguredOpenApiRules()).toEqual(policy);
      expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toEqual(policy[0]);
      expect(findConfiguredOpenApiPolicy('TestPortal', 'ListEntries')).toEqual(policy[0]);
      expect(findConfiguredOpenApiPolicy('OtherPortal', 'CreateEntry')).toEqual(policy[1]);
      expect(snapshot(directory)).toEqual(before);
    },
  );

  it('matches exact product/action pairs without case folding or cross-product expansion', () => {
    const { record } = fixture(firstName, [
      rule(),
      rule({ product: 'OtherPortal', actions: ['ListEntries'], auth: 'required' }),
    ]);
    installed([record]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');

    for (const [product, action] of [
      ['testportal', 'ReadEntry'],
      ['TestPortal', 'readentry'],
      ['TestPortal ', 'ReadEntry'],
      ['TestPortal', ' ReadEntry'],
      ['TestPortal', 'ListEntries'],
      ['OtherPortal', 'ReadEntry'],
      ['UnknownPortal', 'CreateEntry'],
    ]) {
      expect(findConfiguredOpenApiPolicy(product, action)).toBeUndefined();
    }
  });

  it('refreshes changed actions, authentication and response policy in the same process', () => {
    const initial = fixture(firstName, [rule({ response: 'success-code-envelope' })]);
    installed([initial.record]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toMatchObject({
      auth: 'optional',
      response: 'success-code-envelope',
    });
    const replacement = [
      rule({ auth: 'required' }),
      rule({ product: 'OtherPortal', actions: ['NewAction'] }),
    ];
    fixture(firstName, replacement);

    expect(getConfiguredOpenApiRules()).toEqual(replacement);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toEqual(replacement[0]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).not.toHaveProperty('response');
    expect(findConfiguredOpenApiPolicy('OtherPortal', 'NewAction')).toEqual(replacement[1]);

    fixture(firstName, [rule({ actions: ['ReplacementAction'] })]);

    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toBeUndefined();
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReplacementAction')?.auth).toBe('optional');
  });

  it('revokes disabled policy immediately and restores it only when re-enabled', () => {
    const { record } = fixture();
    installed([record]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');

    installed([{ ...record, enabled: false }]);

    expect(getConfiguredOpenApiRules()).toEqual([]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toBeUndefined();

    installed([record]);

    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');
  });

  it('revokes removed plugin records immediately, including when package bytes remain', () => {
    const { directory, record } = fixture();
    installed([record]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');

    installed([]);

    expect(existsSync(path.join(directory, 'package.json'))).toBe(true);
    expect(getConfiguredOpenApiRules()).toEqual([]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toBeUndefined();
  });

  it('honors an explicit disabled-default marker even while an enabled record remains', () => {
    const { record } = fixture();
    installed([record]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');

    installed([record], [firstName]);

    expect(getConfiguredOpenApiRules()).toEqual([]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toBeUndefined();

    installed([record]);

    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');
  });

  it('never promotes optional command authentication into anonymous API permission', () => {
    const { directory, record } = fixture(firstName, undefined, {
      apiPolicy: undefined,
      auth: 'optional',
    });
    installed([record]);
    const parsed = readPluginPackageManifest(directory);
    expect(parsed && validateManifest(parsed)).toBeNull();

    expect(getConfiguredOpenApiRules()).toEqual([]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toBeUndefined();
  });
});

describe('unusable installed plugins cannot grant an API policy', () => {
  it.each([
    'missing entry',
    'missing package',
    'invalid package json',
    'wrong package name',
    'version mismatch',
    'invalid version',
    'missing manifest',
    'incompatible CLI',
    'invalid minimum CLI',
  ])('revokes a previously available policy after %s', (fault) => {
    const { directory, record } = fixture();
    installed([record]);
    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');
    const packagePath = path.join(directory, 'package.json');
    const packageData = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      name: string;
      version: string;
      qianwen?: Record<string, unknown>;
    };
    if (fault === 'missing entry') rmSync(path.join(directory, 'index.mjs'));
    else if (fault === 'missing package') rmSync(packagePath);
    else if (fault === 'invalid package json') writeFileSync(packagePath, '{invalid json');
    else {
      if (fault === 'wrong package name') packageData.name = '@qianwenai/unrelated';
      if (fault === 'version mismatch') packageData.version = '2.0.0';
      if (fault === 'invalid version') {
        packageData.version = 'latest';
        installed([{ ...record, version: 'latest' }]);
      }
      if (fault === 'missing manifest') delete packageData.qianwen;
      if (fault === 'incompatible CLI')
        packageData.qianwen = manifest([rule()], { minCliVersion: '99.0.0' });
      if (fault === 'invalid minimum CLI')
        packageData.qianwen = manifest([rule()], { minCliVersion: 'latest' });
      writeFileSync(packagePath, JSON.stringify(packageData));
    }

    expectClosed();
  });

  it.each(['relative traversal', 'entry symlink', 'package symlink'])(
    'does not obtain rules from a package path that escapes through %s',
    (escape) => {
      const { directory, record } = fixture();
      installed([record]);
      expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');
      const outsideEntry = path.join(isolated.root, 'outside.mjs');
      writeFileSync(outsideEntry, 'export const handlers = { run() {} };');

      if (escape === 'relative traversal') {
        fixture(firstName, [rule()], { entry: path.relative(directory, outsideEntry) });
      } else if (escape === 'entry symlink') {
        rmSync(path.join(directory, 'index.mjs'));
        symlinkSync(outsideEntry, path.join(directory, 'index.mjs'));
      } else {
        const outsidePackage = path.join(isolated.root, 'outside-package');
        mkdirSync(outsidePackage);
        writeFileSync(
          path.join(outsidePackage, 'package.json'),
          readFileSync(path.join(directory, 'package.json')),
        );
        writeFileSync(
          path.join(outsidePackage, 'index.mjs'),
          'export const handlers = { run() {} };',
        );
        rmSync(directory, { recursive: true });
        symlinkSync(outsidePackage, directory);
      }

      expectClosed();
      expect(readFileSync(outsideEntry, 'utf8')).toBe('export const handlers = { run() {} };');
    },
  );
});

describe('policy conflicts fail closed independently of plugin order', () => {
  it.each([{ auth: 'required' as const }, { response: 'success-code-envelope' as const }])(
    'withdraws a conflicting overlapping pair and recovers after disabling its conflicting owner: %j',
    (changes) => {
      const first = fixture(firstName, [rule({ actions: ['ReadEntry', 'ListEntries'] })]);
      installed([first.record]);
      expect(findConfiguredOpenApiPolicy('TestPortal', 'ListEntries')?.auth).toBe('optional');
      const second = fixture(secondName, [
        rule({ actions: ['ListEntries', 'OtherEntry'], ...changes }),
      ]);

      for (const records of [
        [first.record, second.record],
        [second.record, first.record],
      ]) {
        installed(records);
        expect(() => findConfiguredOpenApiPolicy('TestPortal', 'ListEntries')).toThrow(
          expect.objectContaining({ code: 'PLUGIN_API_POLICY_CONFLICT', exitCode: 4 }),
        );
        expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')?.auth).toBe('optional');
        expect(findConfiguredOpenApiPolicy('TestPortal', 'OtherEntry')).toMatchObject(changes);
        expect(
          getConfiguredOpenApiRules().some(
            (item) => item.product === 'TestPortal' && item.actions.includes('ListEntries'),
          ),
        ).toBe(false);
        expect(process.stderr.write).not.toHaveBeenCalled();
      }

      installed([first.record, { ...second.record, enabled: false }]);

      expect(findConfiguredOpenApiPolicy('TestPortal', 'ListEntries')?.auth).toBe('optional');
    },
  );

  it('accepts identical repeated policy and unrelated pairs with independent authentication', () => {
    const first = fixture(firstName, [rule()]);
    const second = fixture(secondName, [
      rule(),
      rule({ product: 'OtherPortal', auth: 'required', response: 'success-code-envelope' }),
    ]);
    installed([first.record, second.record]);

    expect(findConfiguredOpenApiPolicy('TestPortal', 'ReadEntry')).toEqual(rule());
    expect(findConfiguredOpenApiPolicy('OtherPortal', 'ReadEntry')).toEqual(
      rule({ product: 'OtherPortal', auth: 'required', response: 'success-code-envelope' }),
    );
    expect(getConfiguredOpenApiRules()).toEqual(expect.arrayContaining([rule()]));
  });
});
