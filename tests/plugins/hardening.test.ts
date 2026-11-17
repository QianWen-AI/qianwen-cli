import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { Command } from 'commander';
import { readInstalledManifest, validateManifest } from '../../src/plugins/manifest.js';
import { loadInstalledPlugins, registerPluginCommands } from '../../src/plugins/loader.js';

vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => {
    throw new Error('authentication gate reached');
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const valid = { name: 'demo', source: 'npm', version: '1.0.0', enabled: true };

describe('installed manifest hardening', () => {
  it.each([
    null,
    {},
    { name: 42 },
    { name: '../escape' },
    { source: 'unknown' },
    { path: 42 },
    { enabled: 'yes' },
    { version: null },
    { commandAliases: [42] },
  ])('skips malformed metadata without losing valid siblings: %j', (bad) => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        plugins: [
          bad === null
            ? null
            : { ...valid, ...bad, ...(Object.keys(bad).length === 0 ? { name: undefined } : {}) },
          valid,
        ],
      }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(readInstalledManifest('plugins.json').plugins).toEqual([valid]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });

  it('does not resolve unknown-source paths while loading', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        plugins: [{ ...valid, source: 'unexpected', path: '/untrusted' }],
      }),
    );
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(loadInstalledPlugins('plugins.json', 'plugins')).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('command tree hardening', () => {
  it('inherits required auth through intermediate nodes before importing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command().exitOverride();
    registerPluginCommands(program, [
      {
        name: 'demo',
        pkgDir: '.',
        manifest: {
          command: 'demo',
          entry: './nonexistent.mjs',
          auth: 'required',
          subcommands: [{ command: 'group', subcommands: [{ command: 'run', handlerKey: 'run' }] }],
        },
      },
    ]);
    await program.parseAsync(['demo', 'group', 'run'], { from: 'user' }).catch(() => {});
    expect(stderr.mock.calls.flat().join('')).toContain('authentication gate reached');
  });

  it('allows an explicit optional auth override', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command().exitOverride();
    registerPluginCommands(program, [
      {
        name: 'demo',
        pkgDir: '.',
        manifest: {
          command: 'demo',
          entry: './nonexistent.mjs',
          auth: 'required',
          subcommands: [{ command: 'run', auth: 'optional', handlerKey: 'run' }],
        },
      },
    ]);
    await program.parseAsync(['demo', 'run'], { from: 'user' }).catch(() => {});
    const output = stderr.mock.calls.flat().join('');
    expect(output).not.toContain('authentication gate reached');
    expect(output).toContain('nonexistent.mjs');
  });

  it('applies option choices before handler execution', async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerPluginCommands(program, [
      {
        name: 'demo',
        pkgDir: '.',
        manifest: {
          command: 'demo',
          entry: './nonexistent.mjs',
          handlerKey: 'run',
          options: [{ flag: '--mode <mode>', choices: ['fast', 'slow'] }],
        },
      },
    ]);
    await expect(
      program.parseAsync(['demo', '--mode', 'invalid'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });

  it.each(['mode', '--', '--mode <broken', '--mode extra'])('rejects invalid flags: %s', (flag) => {
    expect(
      validateManifest({
        command: 'demo',
        entry: './index.mjs',
        handlerKey: 'run',
        options: [{ flag }],
      }),
    ).toContain('invalid flag');
  });
});
