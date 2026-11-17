import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateDefaultConfig } from '../../src/plugins/defaults.js';
import { validateManifest, type PluginManifest } from '../../src/plugins/manifest.js';

const processes = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    throw new Error('Configuration must not spawn commands');
  }),
  exec: vi.fn(() => {
    throw new Error('Configuration must not execute commands');
  }),
  execFile: vi.fn(() => {
    throw new Error('Configuration must not execute files');
  }),
  execSync: vi.fn(() => {
    throw new Error('Configuration must not execute shell commands');
  }),
  execFileSync: vi.fn(() => {
    throw new Error('Configuration must not execute files');
  }),
}));
vi.mock('node:child_process', () => processes);

function plugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@qianwenai/default-test',
    version: '1.2.3',
    command: 'catalog',
    commandAliases: ['catg'],
    source: { type: 'npm' },
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('default plugin metadata configuration', () => {
  it('accepts an empty default list', () => {
    expect(validateDefaultConfig({ plugins: [] })).toEqual([]);
  });

  it('accepts exact npm package metadata without downloading or executing anything', () => {
    const fetch = vi.fn(() => {
      throw new Error('Configuration must not download packages');
    });
    vi.stubGlobal('fetch', fetch);
    const configured = plugin();

    expect(validateDefaultConfig({ plugins: [configured] })).toEqual([configured]);

    expect(fetch).not.toHaveBeenCalled();
    for (const execute of Object.values(processes)) expect(execute).not.toHaveBeenCalled();
  });

  it('accepts an exact prerelease version', () => {
    const configured = plugin({ version: '1.10.0-plugin.2' });
    expect(validateDefaultConfig({ plugins: [configured] })[0].version).toBe('1.10.0-plugin.2');
  });

  it('accepts archive metadata without reading an archive at validation time', () => {
    const configured = plugin({
      source: { type: 'archive', path: './not-downloaded-yet/default.tgz' },
      sha256: 'a'.repeat(64),
    });

    expect(validateDefaultConfig({ plugins: [configured] })).toEqual([configured]);
  });

  it.each([null, [], 'npm install foo', {}, { plugins: {} }, { plugins: [null] }])(
    'rejects a malformed configuration envelope: %j',
    (input) => expect(() => validateDefaultConfig(input)).toThrow(),
  );

  it.each(['', '../escape', '@scope', 'package name', 'a/b/c', 'foo; echo unsafe'])(
    'rejects an invalid package name: %s',
    (name) => expect(() => validateDefaultConfig({ plugins: [plugin({ name })] })).toThrow(),
  );

  it.each(['latest', '^1.2.3', '>=1.2.3', '1.2', '*', '1.2.3; echo unsafe'])(
    'requires an exact SemVer rather than a range, tag or command: %s',
    (version) => expect(() => validateDefaultConfig({ plugins: [plugin({ version })] })).toThrow(),
  );

  it.each([
    { type: 'shell', command: 'npm install @qianwenai/default-test' },
    'npm install @qianwenai/default-test',
    { type: 'git', url: 'https://git.test.qianwenai.com/default' },
    { type: 'archive' },
    { type: 'archive', path: '' },
  ])('rejects unsupported or incomplete package sources: %j', (source) => {
    expect(() => validateDefaultConfig({ plugins: [plugin({ source })] })).toThrow();
    for (const execute of Object.values(processes)) expect(execute).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'not-a-digest', 'a'.repeat(63), 'g'.repeat(64)])(
    'requires a valid SHA-256 for local archives: %s',
    (sha256) => {
      expect(() =>
        validateDefaultConfig({
          plugins: [
            plugin({
              source: { type: 'archive', path: './default.tgz' },
              sha256,
            }),
          ],
        }),
      ).toThrow();
    },
  );

  it.each([undefined, '', 'catalog search', 'catalog [query]', '--catalog'])(
    'rejects an invalid top-level command identity: %j',
    (command) => {
      expect(() => validateDefaultConfig({ plugins: [plugin({ command })] })).toThrow();
    },
  );

  it.each([
    { command: '', entry: './index.mjs', handlerKey: 'run' },
    { command: 'catalog', entry: './index.mjs' },
    { command: 'catalog', entry: './index.mjs', subcommands: [{ command: 'search' }] },
  ])('rejects invalid command metadata: %j', (manifest) => {
    expect(validateManifest(manifest)).not.toBeNull();
  });

  it.each([
    { manifest: { command: 'catalog', entry: './index.mjs', handlerKey: 'run' } },
    { minCliVersion: '1.0.0' },
    { apiPolicy: [{ product: 'TestPortal', actions: ['ReadEntry'], auth: 'optional' }] },
  ])('rejects plugin-owned metadata embedded in preload configuration: %j', (metadata) => {
    expect(() => validateDefaultConfig({ plugins: [plugin(metadata)] })).toThrow();
  });

  it('rejects duplicate package identities', () => {
    expect(() =>
      validateDefaultConfig({ plugins: [plugin(), plugin({ version: '2.0.0' })] }),
    ).toThrow();
  });

  it.each([
    { command: 'catalog', commandAliases: [] },
    { command: 'catg', commandAliases: [] },
    { command: 'different', commandAliases: ['catalog'] },
    { command: 'different', commandAliases: ['catg'] },
  ])('rejects duplicate top-level commands and aliases: %j', (identity) => {
    const second = plugin({
      name: '@qianwenai/second',
      ...identity,
    });
    expect(() => validateDefaultConfig({ plugins: [plugin(), second] })).toThrow();
  });

  it('allows repeated leaf names under different top-level commands', () => {
    const second = plugin({
      name: '@qianwenai/second',
      command: 'lookup',
      commandAliases: [],
    });
    expect(validateDefaultConfig({ plugins: [plugin(), second] })).toHaveLength(2);
    for (const command of ['catalog', 'lookup']) {
      expect(
        validateManifest({
          command,
          entry: './index.mjs',
          subcommands: [{ command: 'search [query]', handlerKey: 'search' }],
        }),
      ).toBeNull();
    }
  });

  it('accepts authentication and response policy only in the plugin manifest', () => {
    const apiPolicy: PluginManifest['apiPolicy'] = [
      {
        product: 'TestPortal',
        actions: ['ReadEntry'],
        auth: 'optional',
        response: 'success-code-envelope',
      },
    ];
    expect(() => validateDefaultConfig({ plugins: [plugin({ apiPolicy })] })).toThrow();
    expect(
      validateManifest({
        command: 'catalog',
        entry: './index.mjs',
        handlerKey: 'run',
        apiPolicy,
      }),
    ).toBeNull();
  });

  it.each(
    [
      { products: ['TestPortal'], actions: ['ReadEntry'] },
      [{ product: '', actions: ['ReadEntry'], auth: 'required' }],
      [{ product: 'TestPortal', actions: 'ReadEntry', auth: 'required' }],
      [{ product: 'TestPortal', actions: [''], auth: 'required' }],
      [{ product: 'TestPortal', actions: ['ReadEntry'], auth: 'none' }],
      [{ product: 'TestPortal', actions: ['ReadEntry'] }],
      [
        {
          product: 'TestPortal',
          actions: ['ReadEntry'],
          auth: 'optional',
          response: 'unknown-envelope',
        },
      ],
    ].map((apiPolicy) => ({ apiPolicy })),
  )('rejects malformed plugin API policy: $apiPolicy', ({ apiPolicy }) => {
    const manifest = { command: 'catalog', entry: './index.mjs', handlerKey: 'run', apiPolicy };
    expect(validateManifest(manifest as unknown as PluginManifest)).not.toBeNull();
  });

  it('rejects contradictory authentication policies for one API capability', () => {
    const apiPolicy: PluginManifest['apiPolicy'] = [
      { product: 'TestPortal', actions: ['ReadEntry'], auth: 'required' },
      { product: 'TestPortal', actions: ['ReadEntry'], auth: 'optional' },
    ];
    expect(
      validateManifest({
        command: 'catalog',
        entry: './index.mjs',
        handlerKey: 'run',
        apiPolicy,
      }),
    ).not.toBeNull();
  });
});
