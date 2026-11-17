import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDefaultPlugins } from '../../src/plugins/initialize.js';
import { CliError } from '../../src/utils/errors.js';

const state = vi.hoisted(() => ({ ensure: vi.fn(), second: false }));
vi.mock('../../src/plugins/default-install.js', () => ({
  ensureDefaultPlugin: state.ensure,
  recoverManagedPluginInstalls: vi.fn(async () => {}),
}));
vi.mock('../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [
    { name: '@test/prepare-report', version: '1.0.0', command: 'report', source: { type: 'npm' } },
    ...(state.second
      ? [
          {
            name: '@test/prepare-second',
            version: '1.0.0',
            command: 'second',
            source: { type: 'npm' },
          },
        ]
      : []),
  ],
}));
vi.mock('../../src/plugins/loader.js', () => ({
  createPluginInstallContext: () => ({ manifestPath: 'unused' }),
}));
vi.mock('../../src/plugins/manifest.js', () => ({
  readInstalledManifest: () => ({ plugins: [] }),
}));

let root: string;
beforeEach(() => {
  const parent = path.resolve(__dirname, '../../.local-test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, 'prepare-report-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.stubEnv('QIANWEN_PLUGIN_PREPARE_DEADLINE', '');
  state.second = false;
  state.ensure.mockReset().mockRejectedValue(
    Object.assign(
      new CliError({
        code: 'PLUGIN_CLI_INCOMPATIBLE',
        message: 'plugin requires CLI >= 99.0.0 (current 1.0.0)',
        exitCode: 4,
      }),
      { minCliVersion: '99.0.0', currentCliVersion: '1.0.0' },
    ),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('internal preparation report isolation', () => {
  it.each(['regular', 'missing', 'directory', 'symlink', 'write-failure'] as const)(
    'retains the incompatible error when report is %s',
    async (mode) => {
      const report = path.join(root, 'report');
      const sentinel = path.join(root, 'sentinel');
      fs.writeFileSync(sentinel, 'keep');
      if (mode === 'directory') fs.mkdirSync(report);
      else if (mode === 'symlink') fs.symlinkSync(sentinel, report);
      else if (mode !== 'missing') fs.writeFileSync(report, '');
      vi.stubEnv('QIANWEN_PLUGIN_PREPARE_REPORT', report);
      let writeFailed = false;
      if (mode === 'write-failure') {
        const open = fs.openSync;
        vi.spyOn(fs, 'openSync').mockImplementation((file, flags, permissions) => {
          if (String(file) === report) {
            writeFailed = true;
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          return open(file, flags, permissions);
        });
      }
      await expect(initializeDefaultPlugins(new Command('qianwen'))).rejects.toMatchObject({
        exitCode: 4,
      });
      const diagnostic = vi
        .mocked(process.stderr.write)
        .mock.calls.map(([value]) => String(value))
        .join('');
      expect(diagnostic).toContain('PLUGIN_CLI_INCOMPATIBLE');
      expect(diagnostic).not.toContain('denied');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
      if (mode === 'regular') expect(fs.readFileSync(report, 'utf8')).toBe('upgrade-required\n');
      if (mode === 'missing') expect(fs.existsSync(report)).toBe(false);
      if (mode === 'write-failure') {
        expect(writeFailed).toBe(true);
        expect(fs.readFileSync(report, 'utf8')).toBe('');
      }
    },
  );

  it('writes the upgrade marker before a later plugin times out', async () => {
    vi.useFakeTimers();
    state.second = true;
    const report = path.join(root, 'report');
    fs.writeFileSync(report, '');
    vi.stubEnv('QIANWEN_PLUGIN_PREPARE_REPORT', report);
    let release: (() => void) | undefined;
    state.ensure
      .mockRejectedValueOnce(
        new CliError({
          code: 'PLUGIN_CLI_INCOMPATIBLE',
          message: 'requires a newer CLI',
          exitCode: 4,
        }),
      )
      .mockImplementationOnce(
        (_plugin, context: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            release = () => reject(new Error('Fixture released'));
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          }),
      );
    const execution = initializeDefaultPlugins(new Command('qianwen')).catch(
      (error: unknown) => error,
    );
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(state.ensure).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(report, 'utf8')).toBe('upgrade-required\n');
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await execution).toMatchObject({ exitCode: 4 });
      expect(fs.readFileSync(report, 'utf8')).toBe('upgrade-required\n');
    } finally {
      release?.();
      await execution;
    }
  });
});
