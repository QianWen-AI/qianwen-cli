import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerPluginManagementCommands } from '../../../src/commands/plugin/index.js';
import { runPluginValidateChecks } from '../../../src/plugins/validate.js';
import { renderWithInk } from '../../../src/ui/render.js';
import { directoryState } from '../../fixtures/plugin-files.js';
import { projectTmpdir } from '../../fixtures/plugin-temporary-root.js';
import { runCommand } from '../../helpers/run-command.js';

const paths = vi.hoisted(() => ({ root: '', pluginsDir: '', manifestPath: '' }));
vi.mock('../../../src/config/paths.js', async (original) => ({
  ...(await original<typeof import('../../../src/config/paths.js')>()),
  getConfigDir: () => paths.root,
  getPluginsDir: () => paths.pluginsDir,
  getPluginsManifestPath: () => paths.manifestPath,
}));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => paths.root;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../../src/plugins/defaults.js', () => ({
  getDefaultPlugins: () => [],
  getDefaultPlugin: () => undefined,
}));
vi.mock('../../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: vi.fn(async () => {}),
  renderWithInkSync: vi.fn(async () => {}),
}));

type Report = {
  checks: Array<{ name: string; status: string; detail?: string }>;
  summary: { errors: number };
};
let directory: string;
let originalExitCode: typeof process.exitCode;

function packageData(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'malformed-fixture',
    version: '1.0.0',
    qianwen: {
      command: 'malformed-fixture',
      entry: './index.mjs',
      handlerKey: 'run',
      ...changes,
    },
  };
}

function writePackage(data: unknown): void {
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(data));
}

const malformedInputs: Array<{
  label: string;
  data?: unknown;
  raw?: string;
  failedCheck: string;
}> = [
  { label: 'invalid JSON', raw: '{ invalid JSON', failedCheck: 'package.json' },
  ...[null, [], 7, true, 'package'].map((data) => ({
    label: `root ${JSON.stringify(data)}`,
    data,
    failedCheck: 'package.json',
  })),
  { label: 'numeric entry', data: packageData({ entry: 42 }), failedCheck: 'entry-file' },
  ...[
    { label: 'object subcommands', changes: { subcommands: {} } },
    { label: 'null child', changes: { subcommands: [null] } },
    {
      label: 'invalid nested child',
      changes: { subcommands: [{ command: 'group', subcommands: [false] }] },
    },
    { label: 'string aliases', changes: { commandAliases: 'alias' } },
    { label: 'null alias element', changes: { commandAliases: [null] } },
  ].map(({ label, changes }) => ({
    label,
    data: packageData(changes),
    failedCheck: 'manifest-structure',
  })),
];

beforeEach(() => {
  paths.root = fs.mkdtempSync(path.join(projectTmpdir(), 'validate-malformed-'));
  paths.pluginsDir = path.join(paths.root, 'plugins');
  paths.manifestPath = path.join(paths.root, 'plugins.json');
  directory = path.join(paths.root, 'candidate');
  fs.mkdirSync(directory);
  fs.writeFileSync(paths.manifestPath, JSON.stringify({ plugins: [] }));
  fs.writeFileSync(
    path.join(directory, 'index.mjs'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(paths.root, 'handler-imported'))}, 'unexpected');
export const handlers = { run() {} };
`,
  );
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  vi.mocked(renderWithInk).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Static validation must not access the network');
    }),
  );
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(paths.root, 'handler-imported'))).toBe(false);
  } finally {
    process.exitCode = originalExitCode;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

describe('malformed plugin validation remains a static check report', () => {
  for (const format of ['json', 'text', 'table']) {
    it.each(malformedInputs)(
      `reports $label as failed checks in ${format} format`,
      async (input) => {
        if (input.raw) fs.writeFileSync(path.join(directory, 'package.json'), input.raw);
        else writePackage(input.data);
        const before = directoryState(paths.root);
        const checks = runPluginValidateChecks(directory, new Set(), []);
        const failure = checks.find(
          (check) => check.name === input.failedCheck && check.status === 'fail',
        );
        expect(failure?.detail).toEqual(expect.any(String));
        expect(failure?.detail).not.toBe('');
        const writtenOutput: string[] = [];
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
          writtenOutput.push(String(chunk));
          return true;
        }) as typeof process.stdout.write);
        const result = await runCommand(registerPluginManagementCommands, [
          'plugin',
          'validate',
          directory,
          '--format',
          format,
        ]);
        write.mockRestore();
        const stdout = result.stdout + writtenOutput.join('');

        expect(result.exitCode ?? process.exitCode).toBe(1);
        expect(result.stderr).toBe('');
        expect(`${stdout}${result.stderr}`).not.toMatch(/UNKNOWN_ERROR|TypeError|\n\s+at /);
        if (format === 'json') {
          const report = JSON.parse(stdout) as Report;
          expect(report.summary.errors).toBeGreaterThan(0);
          expect(report.checks).toContainEqual(
            expect.objectContaining({ name: input.failedCheck, status: 'fail' }),
          );
          expect(report.summary.errors).toBe(
            report.checks.filter((check) => check.status === 'fail').length,
          );
        } else {
          const displayed = JSON.stringify([stdout, vi.mocked(renderWithInk).mock.calls]);
          expect(displayed).toContain(JSON.stringify(failure?.detail).slice(1, -1));
        }
        expect(directoryState(paths.root)).toEqual(before);
      },
    );
  }

  it('keeps independent passing checks when the command tree is malformed', () => {
    writePackage(packageData({ subcommands: [null], minCliVersion: '1.0.0' }));

    const checks = runPluginValidateChecks(directory, new Set(), []);

    expect(checks).toContainEqual(
      expect.objectContaining({ name: 'manifest-structure', status: 'fail' }),
    );
    for (const name of ['entry-file', 'minCliVersion', 'command-collision']) {
      expect(checks).toContainEqual(expect.objectContaining({ name, status: 'pass' }));
    }
  });

  it('aggregates independent errors after malformed entry and command tree fields', async () => {
    writePackage(
      packageData({
        command: 'models',
        entry: 42,
        subcommands: [{ command: 'nested', subcommands: [null] }],
        minCliVersion: 'not-a-version',
      }),
    );

    const result = await runCommand(
      (program) => {
        program.command('models');
        registerPluginManagementCommands(program);
      },
      ['plugin', 'validate', directory, '--format', 'json'],
    );
    const report = JSON.parse(result.stdout) as Report;

    for (const name of ['manifest-structure', 'entry-file', 'minCliVersion', 'command-collision']) {
      expect(report.checks).toContainEqual(expect.objectContaining({ name, status: 'fail' }));
    }
    expect(result.exitCode ?? process.exitCode).toBe(1);
    expect(result.stderr).toBe('');
  });
});
