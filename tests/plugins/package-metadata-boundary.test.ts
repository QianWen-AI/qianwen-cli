import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadInstalledPlugins, registerPluginCommands } from '../../src/plugins/loader.js';
import { writeInstalledManifest, type InstalledManifest } from '../../src/plugins/manifest.js';
import { projectTmpdir } from '../fixtures/plugin-temporary-root.js';

vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));

type InstalledPlugin = InstalledManifest['plugins'][number];
type EscapeLocation = 'outside-plugins' | 'sibling-package' | 'intermediate-directory';

const rejectedName = 'boundary-plugin';
const healthyName = 'healthy-plugin';
const network = vi.fn(() => {
  throw new Error('Unexpected network access');
});

let root: string;
let pluginsDir: string;
let manifestPath: string;
let healthyDir: string;
let warnings: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(projectTmpdir(), 'package-metadata-boundary-'));
  pluginsDir = path.join(root, 'plugins');
  manifestPath = path.join(root, 'plugins.json');
  healthyDir = packageDirectory(healthyName);
  writePackage(healthyDir, healthyName, healthyName);
  warnings = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  });
  network.mockClear();
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
  expect(network).not.toHaveBeenCalled();
});

function packageDirectory(name: string): string {
  return path.join(pluginsDir, 'node_modules', name);
}

function writeMetadata(file: string, name: string, command: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      name,
      version: '1.0.0',
      qianwen: { command, entry: './entry.mjs', handlerKey: 'run', auth: 'optional' },
    }),
  );
}

function writeEntry(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'entry.mjs'), 'export const handlers = { run() {} };');
}

function writePackage(directory: string, name: string, command: string): void {
  writeMetadata(path.join(directory, 'package.json'), name, command);
  writeEntry(directory);
}

function installed(name: string, source: InstalledPlugin['source'], directory?: string) {
  return {
    name,
    source,
    version: '1.0.0',
    enabled: true,
    ...(directory ? { path: directory } : {}),
  } satisfies InstalledPlugin;
}

function writeManifest(candidate: InstalledPlugin): void {
  writeInstalledManifest(manifestPath, {
    plugins: [candidate, installed(healthyName, 'npm')],
  });
}

function loadAndRegister() {
  const reads = vi.spyOn(fs, 'readFileSync');
  const loaded = loadInstalledPlugins(manifestPath, pluginsDir);
  const program = new Command();
  registerPluginCommands(program, loaded);
  return {
    loaded,
    commands: program.commands.map((command) => command.name()),
    readPaths: reads.mock.calls.map(([file]) => String(file)),
  };
}

function expectRejected(
  result: ReturnType<typeof loadAndRegister>,
  unreadableMetadataPaths: string[],
): void {
  expect(result.readPaths).toContain(path.join(healthyDir, 'package.json'));
  for (const metadataPath of unreadableMetadataPaths) {
    expect(result.readPaths).not.toContain(metadataPath);
  }
  expect(result.loaded.map((plugin) => plugin.name)).toEqual([healthyName]);
  expect(result.commands).toEqual([healthyName]);
  expect(warnings.join('')).toContain(rejectedName);
  expect(warnings.join('')).toMatch(/package|metadata|manifest/i);
}

function rejectOutwardMetadata(source: InstalledPlugin['source'], location: EscapeLocation): void {
  const directory = packageDirectory(rejectedName);
  writeEntry(directory);
  const metadataPath = path.join(directory, 'package.json');
  const externalDirectory =
    location === 'sibling-package'
      ? packageDirectory(`${rejectedName}-sibling`)
      : path.join(root, 'external-metadata');
  const externalMetadata = path.join(externalDirectory, 'package.json');
  writeMetadata(externalMetadata, rejectedName, 'boundary-command');

  if (location === 'intermediate-directory') {
    fs.symlinkSync(externalDirectory, path.join(directory, 'metadata'), 'dir');
    fs.symlinkSync('./metadata/package.json', metadataPath, 'file');
  } else {
    fs.symlinkSync(externalMetadata, metadataPath, 'file');
  }
  writeManifest(installed(rejectedName, source));

  expectRejected(loadAndRegister(), [
    metadataPath,
    externalMetadata,
    path.join(directory, 'metadata', 'package.json'),
  ]);
}

describe.each(['npm', 'local', 'archive'] as const)(
  'managed %s package metadata containment',
  (source) => {
    it('rejects metadata linked to a prefix-sharing sibling package before reading or registration', () => {
      rejectOutwardMetadata(source, 'sibling-package');
    });

    it('rejects a dangling package.json link before attempting a metadata read', () => {
      const directory = packageDirectory(rejectedName);
      writeEntry(directory);
      const metadataPath = path.join(directory, 'package.json');
      const missingMetadata = path.join(root, 'missing-metadata.json');
      fs.symlinkSync(missingMetadata, metadataPath, 'file');
      writeManifest(installed(rejectedName, source));

      expectRejected(loadAndRegister(), [metadataPath, missingMetadata]);
    });

    it.each(['regular-file', 'contained-link'] as const)(
      'loads and registers valid package metadata stored as a %s',
      (kind) => {
        const directory = packageDirectory('valid-plugin');
        writeEntry(directory);
        const metadataPath = path.join(directory, 'package.json');
        if (kind === 'contained-link') {
          writeMetadata(path.join(directory, 'metadata', 'package.json'), 'valid-plugin', 'valid');
          fs.symlinkSync('./metadata/package.json', metadataPath, 'file');
        } else {
          writeMetadata(metadataPath, 'valid-plugin', 'valid');
        }
        writeManifest(installed('valid-plugin', source));

        const result = loadAndRegister();

        expect(result.loaded.map((plugin) => plugin.name)).toEqual(['valid-plugin', healthyName]);
        expect(result.commands).toEqual(['valid', healthyName]);
        expect(warnings).toEqual([]);
      },
    );
  },
);

describe('resolved package metadata paths', () => {
  it.each(['outside-plugins', 'intermediate-directory'] as const)(
    'rejects outward metadata through %s before reading or registration',
    (location) => {
      rejectOutwardMetadata('npm', location);
    },
  );

  it('accepts metadata inside a contained real package directory behind a root link', () => {
    const actualDirectory = path.join(pluginsDir, 'store', 'valid-plugin');
    writeEntry(actualDirectory);
    writeMetadata(path.join(actualDirectory, 'metadata', 'package.json'), 'valid-plugin', 'valid');
    fs.symlinkSync('./metadata/package.json', path.join(actualDirectory, 'package.json'), 'file');
    fs.symlinkSync(actualDirectory, packageDirectory('valid-plugin'), 'dir');
    writeManifest(installed('valid-plugin', 'npm'));

    const result = loadAndRegister();

    expect(result.loaded.map((plugin) => plugin.name)).toEqual(['valid-plugin', healthyName]);
    expect(result.commands).toEqual(['valid', healthyName]);
    expect(warnings).toEqual([]);
  });

  it.each(['link', 'bundle'] as const)(
    'preserves an intentional external %s development package root',
    (source) => {
      const directory = path.join(root, 'development-package');
      writePackage(directory, 'development-plugin', 'development');
      writeManifest(installed('development-plugin', source, directory));

      const result = loadAndRegister();

      expect(result.loaded.map((plugin) => plugin.name)).toEqual([
        'development-plugin',
        healthyName,
      ]);
      expect(result.commands).toEqual(['development', healthyName]);
      expect(warnings).toEqual([]);
    },
  );
});
