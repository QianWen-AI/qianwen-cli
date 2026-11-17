import { recoveryWorker, type RecoveryWorker } from '../fixtures/recovery-worker.js';
import { directoryState } from '../fixtures/plugin-files.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  InstalledManifest,
  InstalledPlugin,
  PluginManifest,
} from '../../src/plugins/manifest.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const packageName = '@qianwenai/uninstall-recovery-test';
const policy = {
  product: 'UninstallRecoveryPortal',
  actions: ['ReadEntry'],
  auth: 'optional' as const,
};
const declared: PluginManifest = {
  command: 'uninstallrecovery',
  entry: './index.mjs',
  handlerKey: 'run',
  minCliVersion: '1.0.0',
  apiPolicy: [policy],
};
const oldRecord: InstalledPlugin = {
  name: packageName,
  version: '1.0.0',
  source: 'local',
  enabled: true,
  command: declared.command,
};
const unrelated: InstalledPlugin = {
  name: '@qianwenai/uninstall-unrelated',
  version: '3.0.0',
  source: 'local',
  enabled: true,
  command: 'uninstallunrelated',
};

type Boundary = 'uninstall-started' | 'old-moved' | 'manifest-committed';
type Operation = 'uninstall' | 'recover' | 'policy';

interface WorkerResult {
  event: 'result';
  error?: { code?: string; exitCode?: number; message: string };
  policy?: unknown[];
  fetchCalls: number;
}

type Worker = RecoveryWorker<WorkerResult>;

let root: string;
let pluginsDir: string;
let manifestPath: string;
let destination: string;
let workerPath: string;
let workers: Worker[];

function installed(): InstalledManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as InstalledManifest;
}

const snapshot = (directory = pluginsDir) => directoryState(directory);

function writePackage(record: InstalledPlugin, manifest: PluginManifest, content: string): void {
  const directory = path.join(pluginsDir, 'node_modules', record.name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: record.name, version: record.version, qianwen: manifest }),
  );
  fs.writeFileSync(path.join(directory, 'index.mjs'), 'export const handlers = { run() {} };');
  fs.writeFileSync(path.join(directory, 'content.txt'), content);
}

function expectCleanArtifacts(present: boolean): void {
  const expectedNames = present ? [packageName, unrelated.name] : [unrelated.name];
  const expectedFiles = expectedNames.flatMap((name) =>
    ['package.json', 'index.mjs', 'content.txt'].map((file) =>
      path.join(pluginsDir, 'node_modules', name, file),
    ),
  );
  expect(Object.keys(snapshot()).sort()).toEqual(expectedFiles.sort());
  expect(fs.existsSync(`${manifestPath}.lock`)).toBe(false);
}

function expectState(committed: boolean, defaultPlugin: boolean): void {
  expect(installed().plugins.find((record) => record.name === unrelated.name)).toEqual(unrelated);
  expect(installed().disabledDefaults).toContain('@qianwenai/other-disabled');
  expect(fs.existsSync(destination)).toBe(!committed);
  if (committed) {
    expect(installed().plugins.find((record) => record.name === packageName)).toBeUndefined();
    if (defaultPlugin) expect(installed().disabledDefaults).toContain(packageName);
    else expect(installed().disabledDefaults ?? []).not.toContain(packageName);
  } else {
    expect(installed().plugins.find((record) => record.name === packageName)).toEqual(oldRecord);
    expect(fs.readFileSync(path.join(destination, 'content.txt'), 'utf8')).toBe('old');
    expect(installed().disabledDefaults ?? []).not.toContain(packageName);
  }
  expect(
    fs.readFileSync(path.join(pluginsDir, 'node_modules', unrelated.name, 'content.txt'), 'utf8'),
  ).toBe('unrelated');
}

function startWorker(
  operation: Operation,
  options: {
    boundary?: Boundary;
    holdBoundary?: boolean;
    defaultPlugin?: boolean;
    lockTimeoutMs?: number;
  } = {},
): Worker {
  const number = workers.length;
  const boundaryPath = path.join(root, `boundary-${number}.json`);
  const configPath = path.join(root, `worker-${number}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      operation,
      boundary: options.boundary,
      holdBoundary: options.holdBoundary ?? false,
      boundaryPath,
      destination,
      packageName,
      stateDir: root,
      serviceUrl: pathToFileURL(path.join(workspace, 'src/plugins/default-install.ts')).href,
      policyUrl: pathToFileURL(path.join(workspace, 'src/config/openapi-policy.ts')).href,
      context: {
        pluginsDir,
        manifestPath,
        cliVersion: '1.10.0',
        definitions:
          options.defaultPlugin === false
            ? []
            : [
                {
                  name: packageName,
                  version: '1.0.0',
                  command: declared.command,
                  source: { type: 'archive', path: path.join(root, 'never-install.tgz') },
                },
              ],
        lockTimeoutMs: options.lockTimeoutMs ?? 5_000,
        lockPollMs: 10,
      },
    }),
  );
  const worker = recoveryWorker<WorkerResult>(root, workerPath, configPath, boundaryPath);
  workers.push(worker);
  return worker;
}

async function killAtBoundary(boundary: Boundary, defaultPlugin = true): Promise<Worker> {
  const worker = startWorker('uninstall', { boundary, defaultPlugin });
  expect(await worker.exited).toEqual({ code: null, signal: 'SIGKILL' });
  expect(JSON.parse(fs.readFileSync(worker.boundaryPath, 'utf8')).boundary).toBe(boundary);
  return worker;
}

async function recover(defaultPlugin = true): Promise<WorkerResult> {
  return startWorker('recover', { defaultPlugin }).result();
}

beforeEach(() => {
  const temporaryRoot = path.join(workspace, '.local-test-tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  root = fs.mkdtempSync(path.join(temporaryRoot, 'uninstall-recovery-process-'));
  pluginsDir = path.join(root, 'plugins');
  manifestPath = path.join(root, 'plugins.json');
  destination = path.join(pluginsDir, 'node_modules', packageName);
  workerPath = path.join(root, 'uninstall-worker.mjs');
  workers = [];
  fs.writeFileSync(path.join(root, '.npmrc'), 'registry=https://registry.test.qianwenai.com/\n');
  writePackage(oldRecord, declared, 'old');
  writePackage(
    unrelated,
    { ...declared, command: 'uninstallunrelated', apiPolicy: [] },
    'unrelated',
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      plugins: [oldRecord, unrelated],
      disabledDefaults: ['@qianwenai/other-disabled'],
    }),
  );
  fs.writeFileSync(
    workerPath,
    `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
os.homedir = () => config.stateDir;
os.tmpdir = () => config.stateDir;
const rename = fs.renameSync;
function stopAt(boundary, from, to) {
  if (boundary !== config.boundary) return;
  fs.writeFileSync(config.boundaryPath, JSON.stringify({ boundary, from, to }));
  if (config.holdBoundary) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  process.kill(process.pid, 'SIGKILL');
}
fs.renameSync = (from, to) => {
  if (String(from) === config.destination) stopAt('uninstall-started', from, to);
  const result = rename(from, to);
  if (String(from) === config.destination) stopAt('old-moved', from, to);
  if (String(to) === config.context.manifestPath) stopAt('manifest-committed', from, to);
  return result;
};
syncBuiltinESMExports();
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  throw new Error('Network is forbidden in uninstall recovery tests');
};
try {
  if (config.operation === 'policy') {
    const policy = await import(config.policyUrl);
    process.send({ event: 'result', policy: policy.getConfiguredOpenApiRules(), fetchCalls });
  } else {
    const service = await import(config.serviceUrl);
    const context = { ...config.context, reservedNames: new Set(['models', 'm', 'plugin']) };
    if (config.operation === 'uninstall') await service.uninstallManagedPlugin(config.packageName, context);
    else await service.installManagedPlugin(path.join(config.stateDir, 'missing-source'), context);
    process.send({ event: 'result', fetchCalls });
  }
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
  fs.rmSync(root, { recursive: true, force: true });
});

describe('uninstall recovery after a real process is killed', () => {
  const cases = [true, false].flatMap((defaultPlugin) =>
    (['old-moved', 'manifest-committed'] as const).map((boundary) => ({ defaultPlugin, boundary })),
  );

  it.each(cases)(
    'recovers default=$defaultPlugin after $boundary and remains idempotent',
    async ({ boundary, defaultPlugin }) => {
      const before = fs.readFileSync(manifestPath, 'utf8');
      await killAtBoundary(boundary, defaultPlugin);
      const committed = boundary === 'manifest-committed';
      const expectedManifest = committed ? fs.readFileSync(manifestPath, 'utf8') : before;

      await recover(defaultPlugin);

      expectState(committed, defaultPlugin);
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(expectedManifest);
      expectCleanArtifacts(!committed);
      await recover(defaultPlugin);
      expectState(committed, defaultPlugin);
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(expectedManifest);
      expectCleanArtifacts(!committed);
    },
    30_000,
  );

  it('withdraws policy while uninstall is pending even before the old package moves, without recovering on read', async () => {
    expect((await startWorker('policy').result()).policy).toEqual([policy]);
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    await killAtBoundary('uninstall-started');
    expect(fs.existsSync(path.join(destination, 'index.mjs'))).toBe(true);
    const before = snapshot();
    const lockBefore = snapshot(`${manifestPath}.lock`);

    const read = await startWorker('policy').result();

    expect(read.error).toBeUndefined();
    expect(read.policy).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(snapshot(`${manifestPath}.lock`)).toEqual(lockBefore);
    await recover();
    expectState(false, true);
    expect((await startWorker('policy').result()).policy).toEqual([policy]);
    expectCleanArtifacts(true);
  }, 30_000);

  it('does not recover a pending uninstall until the owning process releases the manifest lock', async () => {
    const owner = startWorker('uninstall', { boundary: 'old-moved', holdBoundary: true });
    await expect.poll(() => fs.existsSync(owner.boundaryPath), { timeout: 10_000 }).toBe(true);
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const before = snapshot();

    const contender = await startWorker('recover', { lockTimeoutMs: 150 }).result();

    expect(contender.error).toMatchObject({ code: 'PLUGIN_INSTALL_LOCK_TIMEOUT', exitCode: 4 });
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();
    owner.child.kill('SIGKILL');
    expect(await owner.exited).toEqual({ code: null, signal: 'SIGKILL' });
    await recover();
    expectState(false, true);
    expectCleanArtifacts(true);
  }, 30_000);

  it.each(['destination', 'backup'] as const)(
    'refuses a symbolic-link %s during uninstall recovery and preserves its target',
    async (link) => {
      const before = fs.readFileSync(manifestPath, 'utf8');
      const worker = await killAtBoundary('old-moved');
      const boundary = JSON.parse(fs.readFileSync(worker.boundaryPath, 'utf8')) as { to: string };
      const victim = path.join(root, 'unrelated-directory');
      fs.mkdirSync(victim);
      fs.writeFileSync(path.join(victim, 'sentinel'), 'keep');
      const candidate = link === 'destination' ? destination : boundary.to;
      if (fs.existsSync(candidate))
        fs.renameSync(candidate, path.join(root, 'preserved-old-package'));
      fs.symlinkSync(victim, candidate);
      const filesBefore = snapshot();

      const result = await recover();

      expect(result.error).toMatchObject({ code: 'PLUGIN_INSTALL_RECOVERY_FAILED', exitCode: 4 });
      expect(fs.readFileSync(path.join(victim, 'sentinel'), 'utf8')).toBe('keep');
      expect(snapshot()).toEqual(filesBefore);
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(before);
      expect(fs.existsSync(`${manifestPath}.lock`)).toBe(false);
    },
    30_000,
  );

  it('rejects a traversal package name in a real uninstall journal without touching any target', async () => {
    const before = fs.readFileSync(manifestPath, 'utf8');
    await killAtBoundary('old-moved');
    const journals = Object.keys(snapshot()).filter(
      (file) => file.endsWith('.json') && path.basename(file) !== 'package.json',
    );
    expect(journals).toHaveLength(1);
    const journal = JSON.parse(fs.readFileSync(journals[0], 'utf8')) as Record<string, unknown>;
    journal.name = '../outside';
    fs.writeFileSync(journals[0], JSON.stringify(journal));
    const victim = path.resolve(pluginsDir, 'node_modules', '../outside');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'sentinel'), 'keep');
    const filesBefore = snapshot();

    const result = await recover();

    expect(result.error).toMatchObject({ code: 'PLUGIN_INSTALL_RECOVERY_FAILED', exitCode: 4 });
    expect(snapshot()).toEqual(filesBefore);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(victim, 'sentinel'), 'utf8')).toBe('keep');
    expect(fs.existsSync(`${manifestPath}.lock`)).toBe(false);
  }, 30_000);
});
