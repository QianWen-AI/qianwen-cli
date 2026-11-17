import { recoveryWorker, type RecoveryWorker } from '../fixtures/recovery-worker.js';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DefaultPlugin } from '../../src/plugins/defaults.js';
import type {
  InstalledManifest,
  InstalledPlugin,
  PluginManifest,
} from '../../src/plugins/manifest.js';
import { buildTarball } from '../fixtures/tar-builder.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const packageName = '@qianwenai/recovery-test';
const pluginManifest: PluginManifest = {
  command: 'recoverycatalog',
  commandAliases: ['recoverycat'],
  entry: './index.mjs',
  handlerKey: 'run',
  minCliVersion: '1.0.0',
};
const unrelated: InstalledPlugin = {
  name: '@qianwenai/unrelated-recovery-test',
  version: '3.0.0',
  source: 'npm',
  enabled: true,
  command: 'unrelated',
  commandAliases: [],
};

type Boundary = 'old-moved' | 'candidate-moved' | 'manifest-committed';
type Operation = 'ensure' | 'install';

interface WorkerResult {
  event: 'result';
  record?: InstalledPlugin;
  error?: { code?: string; exitCode?: number; message: string };
  fetchCalls: number;
}

type Worker = RecoveryWorker<WorkerResult>;

let root: string;
let pluginsDir: string;
let manifestPath: string;
let destination: string;
let sourcePath: string;
let workerPath: string;
let workers: Worker[];

function definition(version = '1.0.0', archive?: string): DefaultPlugin {
  return {
    name: packageName,
    version,
    command: pluginManifest.command,
    commandAliases: pluginManifest.commandAliases,
    source: { type: 'archive', path: archive ?? path.join(root, 'missing-archive.tgz') },
    sha256: archive
      ? createHash('sha256').update(readFileSync(archive)).digest('hex')
      : '0'.repeat(64),
  };
}

function writeCandidate(version: string, content: string): string {
  mkdirSync(sourcePath, { recursive: true });
  const packageJson = JSON.stringify({ name: packageName, version, qianwen: pluginManifest });
  const entry = `export const handlers = { run() { return ${JSON.stringify(content)}; } };`;
  writeFileSync(path.join(sourcePath, 'package.json'), packageJson);
  writeFileSync(path.join(sourcePath, 'index.mjs'), entry);
  writeFileSync(path.join(sourcePath, 'content.txt'), content);
  const archive = path.join(root, `candidate-${content}.tgz`);
  writeFileSync(
    archive,
    buildTarball([
      { name: 'package/package.json', data: packageJson },
      { name: 'package/index.mjs', data: entry },
      { name: 'package/content.txt', data: content },
    ]),
  );
  return archive;
}

function installed(): InstalledManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledManifest;
}

function artifactPaths(directory = pluginsDir): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return [absolute, ...(entry.isDirectory() ? artifactPaths(absolute) : [])];
  });
}

function expectCleanArtifacts(): void {
  expect(
    artifactPaths().filter((entry) => {
      const name = path.basename(entry);
      return name.startsWith('.qianwen-plugin-') || name.includes('.qianwen-bak-');
    }),
  ).toEqual([]);
  expect(existsSync(`${manifestPath}.lock`)).toBe(false);
}

function expectContent(content: string, version: string): void {
  expect(existsSync(destination)).toBe(true);
  expect(readFileSync(path.join(destination, 'content.txt'), 'utf8')).toBe(content);
  expect(JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8')).version).toBe(
    version,
  );
  expect(installed().plugins.find((record) => record.name === packageName)?.version).toBe(version);
  expect(installed().plugins.find((record) => record.name === unrelated.name)).toEqual(unrelated);
  expect(installed().disabledDefaults).toContain('@qianwenai/other-disabled');
}

function startWorker(
  operation: Operation,
  options: {
    configured?: DefaultPlugin;
    boundary?: Boundary;
    holdBoundary?: boolean;
    failedInput?: boolean;
    lockTimeoutMs?: number;
  } = {},
): Worker {
  const configured = options.configured ?? definition();
  const number = workers.length;
  const boundaryPath = path.join(root, `boundary-${number}.json`);
  const configPath = path.join(root, `worker-${number}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      operation,
      definition: configured,
      boundary: options.boundary,
      holdBoundary: options.holdBoundary ?? false,
      boundaryPath,
      destination,
      sourcePath: options.failedInput ? path.join(root, 'missing-source') : sourcePath,
      stateDir: root,
      serviceUrl: pathToFileURL(path.join(workspace, 'src/plugins/default-install.ts')).href,
      context: {
        pluginsDir,
        manifestPath,
        cliVersion: '1.10.0',
        definitions: [configured],
        lockTimeoutMs: options.lockTimeoutMs ?? 5_000,
        lockPollMs: 10,
      },
    }),
  );
  const worker = recoveryWorker<WorkerResult>(root, workerPath, configPath, boundaryPath);
  workers.push(worker);
  return worker;
}

async function seedInstalled(): Promise<string> {
  writeCandidate('1.0.0', 'old');
  const result = await startWorker('install').result();
  expect(result.error).toBeUndefined();
  expectContent('old', '1.0.0');
  return readFileSync(manifestPath, 'utf8');
}

async function killAtBoundary(
  boundary: Boundary,
  operation: Operation = 'install',
  version = '2.0.0',
): Promise<Worker> {
  const archive = writeCandidate(version, 'new');
  const owner = startWorker(operation, {
    boundary,
    configured: operation === 'ensure' ? definition(version, archive) : definition(),
  });
  expect(await owner.exited).toEqual({ code: null, signal: 'SIGKILL' });
  expect(JSON.parse(readFileSync(owner.boundaryPath, 'utf8')).boundary).toBe(boundary);
  return owner;
}

async function recover(operation: Operation): Promise<WorkerResult> {
  return startWorker(operation, { failedInput: operation === 'install' }).result();
}

beforeEach(() => {
  const temporaryRoot = path.join(workspace, '.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  root = mkdtempSync(path.join(temporaryRoot, 'install-recovery-process-'));
  pluginsDir = path.join(root, 'plugins');
  manifestPath = path.join(root, 'plugins.json');
  destination = path.join(pluginsDir, 'node_modules', packageName);
  sourcePath = path.join(root, 'source-package');
  workerPath = path.join(root, 'install-worker.mjs');
  workers = [];
  writeFileSync(path.join(root, '.npmrc'), 'registry=https://registry.test.qianwenai.com/\n');
  writeFileSync(
    manifestPath,
    JSON.stringify({ plugins: [unrelated], disabledDefaults: ['@qianwenai/other-disabled'] }),
  );
  writeFileSync(
    workerPath,
    `import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
os.homedir = () => config.stateDir;
os.tmpdir = () => config.stateDir;
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const result = rename(from, to);
  const boundary = String(from) === config.destination ? 'old-moved'
    : String(to) === config.destination ? 'candidate-moved'
    : String(to) === config.context.manifestPath ? 'manifest-committed' : undefined;
  if (boundary && boundary === config.boundary) {
    fs.writeFileSync(config.boundaryPath, JSON.stringify({ boundary, from, to }));
    if (config.holdBoundary) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
syncBuiltinESMExports();
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  throw new Error('Network is forbidden in install recovery tests');
};
try {
  const service = await import(config.serviceUrl);
  const context = { ...config.context, reservedNames: new Set(['models', 'm', 'plugin']) };
  const record = config.operation === 'ensure'
    ? await service.ensureDefaultPlugin(config.definition, context)
    : await service.installManagedPlugin(config.sourcePath, context);
  process.send({ event: 'result', record, fetchCalls });
} catch (error) {
  process.send({ event: 'result', error: { code: error.code, exitCode: error.exitCode, message: error.message }, fetchCalls });
} finally {
  process.disconnect();
}
`,
  );
});

afterEach(async () => {
  await Promise.all(
    workers.map(async (worker) => {
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill('SIGKILL');
      await worker.exited;
    }),
  );
  rmSync(root, { recursive: true, force: true });
});

describe('plugin install recovery after a killed process', () => {
  const upgrades = (['install', 'ensure'] as const).flatMap((operation) =>
    (['old-moved', 'candidate-moved', 'manifest-committed'] as const).map((boundary) => ({
      operation,
      boundary,
      recovery: operation === 'install' ? ('ensure' as const) : ('install' as const),
    })),
  );

  it.each(upgrades)(
    '$operation upgrade killed at $boundary is recovered by $recovery in another process',
    async ({ operation, boundary, recovery }) => {
      const before = await seedInstalled();
      await killAtBoundary(boundary, operation);
      const committed = boundary === 'manifest-committed';
      const expectedManifest = committed ? readFileSync(manifestPath, 'utf8') : before;

      const result = await recover(recovery);

      if (recovery === 'ensure') expect(result.error).toBeUndefined();
      else expect(result.error).toBeDefined();
      expectContent(committed ? 'new' : 'old', committed ? '2.0.0' : '1.0.0');
      expect(readFileSync(manifestPath, 'utf8')).toBe(expectedManifest);
      expectCleanArtifacts();

      const repeated = await recover('ensure');
      expect(repeated.error).toBeUndefined();
      expectContent(committed ? 'new' : 'old', committed ? '2.0.0' : '1.0.0');
      expect(readFileSync(manifestPath, 'utf8')).toBe(expectedManifest);
      expectCleanArtifacts();
    },
    30_000,
  );

  it.each(['candidate-moved', 'manifest-committed'] as const)(
    'same-version reinstall killed at %s uses commit state instead of version equality',
    async (boundary) => {
      const before = await seedInstalled();
      await killAtBoundary(boundary, 'install', '1.0.0');
      const committed = boundary === 'manifest-committed';
      const expectedManifest = committed ? readFileSync(manifestPath, 'utf8') : before;

      const result = await recover('ensure');

      expect(result.error).toBeUndefined();
      expectContent(committed ? 'new' : 'old', '1.0.0');
      expect(readFileSync(manifestPath, 'utf8')).toBe(expectedManifest);
      expectCleanArtifacts();
    },
    30_000,
  );

  it.each(['candidate-moved', 'manifest-committed'] as const)(
    'first install killed at %s keeps only a committed package',
    async (boundary) => {
      const before = readFileSync(manifestPath, 'utf8');
      await killAtBoundary(boundary, 'ensure');
      const committed = boundary === 'manifest-committed';
      const expectedManifest = committed ? readFileSync(manifestPath, 'utf8') : before;

      const result = await recover('ensure');

      if (committed) {
        expect(result.error).toBeUndefined();
        expectContent('new', '2.0.0');
      } else {
        expect(result.error).toBeDefined();
        expect(existsSync(destination)).toBe(false);
        expect(installed().plugins).toEqual([unrelated]);
      }
      expect(readFileSync(manifestPath, 'utf8')).toBe(expectedManifest);
      expectCleanArtifacts();

      await recover('ensure');
      expect(readFileSync(manifestPath, 'utf8')).toBe(expectedManifest);
      expect(existsSync(destination)).toBe(committed);
      expectCleanArtifacts();
    },
    30_000,
  );

  it.each(['disabled-record', 'uninstalled-default'] as const)(
    'interrupted explicit reinstall preserves %s during automatic recovery',
    async (state) => {
      if (state === 'disabled-record') {
        await seedInstalled();
        const manifest = installed();
        manifest.plugins = manifest.plugins.map((record) =>
          record.name === packageName ? { ...record, enabled: false } : record,
        );
        writeFileSync(manifestPath, JSON.stringify(manifest));
      } else {
        const manifest = installed();
        manifest.disabledDefaults = [...(manifest.disabledDefaults ?? []), packageName];
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      const before = readFileSync(manifestPath, 'utf8');
      await killAtBoundary('candidate-moved');

      const result = await recover('ensure');

      expect(result.error).toMatchObject({ code: 'PLUGIN_DEFAULT_DISABLED', exitCode: 4 });
      expect(readFileSync(manifestPath, 'utf8')).toBe(before);
      if (state === 'disabled-record') expectContent('old', '1.0.0');
      else expect(existsSync(destination)).toBe(false);
      expectCleanArtifacts();
    },
    30_000,
  );

  it('does not recover another process transaction before obtaining its lock', async () => {
    await seedInstalled();
    writeCandidate('2.0.0', 'new');
    const owner = startWorker('install', { boundary: 'candidate-moved', holdBoundary: true });
    await expect.poll(() => existsSync(owner.boundaryPath), { timeout: 10_000 }).toBe(true);
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const artifactsBefore = artifactPaths();

    const contender = await startWorker('ensure', { lockTimeoutMs: 150 }).result();

    expect(contender.error).toMatchObject({ code: 'PLUGIN_INSTALL_LOCK_TIMEOUT', exitCode: 4 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readFileSync(path.join(destination, 'content.txt'), 'utf8')).toBe('new');
    expect(artifactPaths()).toEqual(artifactsBefore);
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();

    owner.child.kill('SIGKILL');
    expect(await owner.exited).toEqual({ code: null, signal: 'SIGKILL' });
    const recovered = await recover('ensure');
    expect(recovered.error).toBeUndefined();
    expectContent('old', '1.0.0');
    expectCleanArtifacts();
  }, 30_000);
});
