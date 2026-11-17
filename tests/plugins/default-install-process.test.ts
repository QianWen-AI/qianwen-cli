import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const require = createRequire(import.meta.url);
const packageName = '@qianwenai/process-default';
const pluginManifest: PluginManifest = {
  command: 'processcatalog',
  commandAliases: ['pcatalog'],
  entry: './index.mjs',
  handlerKey: 'run',
  minCliVersion: '1.0.0',
};
const unrelated: InstalledPlugin = {
  name: '@qianwenai/unrelated-process-test',
  version: '3.0.0',
  source: 'npm',
  enabled: true,
  command: 'unrelated',
  commandAliases: [],
};

interface WorkerMessage {
  event: 'started' | 'download-started' | 'result';
  record?: InstalledPlugin;
  error?: { code?: string; exitCode?: number; message: string };
  fetchCalls?: number;
}

interface Worker {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor(event: WorkerMessage['event']): Promise<WorkerMessage>;
}

let root: string;
let manifestPath: string;
let pluginsDir: string;
let workerPath: string;
let workers: Worker[];

function definition(version: string, archive?: string): DefaultPlugin {
  return {
    name: packageName,
    version,
    command: pluginManifest.command,
    commandAliases: pluginManifest.commandAliases,
    source: archive ? { type: 'archive', path: archive } : { type: 'npm' },
  };
}

function startWorker(
  configured: DefaultPlugin,
  options: { blockDownload?: boolean; lockTimeoutMs?: number } = {},
): Worker {
  const archivePath = path.join(root, `package-${workers.length}.tgz`);
  writeFileSync(
    archivePath,
    buildTarball([
      {
        name: 'package/package.json',
        data: JSON.stringify({
          name: packageName,
          version: configured.version,
          qianwen: pluginManifest,
        }),
      },
      { name: 'package/index.mjs', data: 'export const handlers = { run() {} };' },
    ]),
  );
  if (configured.source.type === 'archive') {
    configured = {
      ...configured,
      source: { type: 'archive', path: archivePath },
      sha256: createHash('sha256').update(readFileSync(archivePath)).digest('hex'),
    };
  }
  const configPath = path.join(root, `worker-${workers.length}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      definition: configured,
      pluginManifest,
      archivePath,
      stateDir: root,
      serviceUrl: pathToFileURL(path.join(workspace, 'src/plugins/default-install.ts')).href,
      blockDownload: options.blockDownload ?? false,
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
  const child = fork(workerPath, [configPath], {
    cwd: root,
    execArgv: ['--import', require.resolve('tsx')],
    env: {
      ...process.env,
      TSX_DISABLE_CACHE: '1',
      QIANWEN_CONFIG_DIR: root,
      QIANWEN_KEYRING: 'no',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: WorkerMessage[] = [];
  let diagnostic = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  child.on('message', (message: WorkerMessage) => {
    messages.push(message);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const worker: Worker = {
    child,
    exited,
    waitFor(event) {
      const existing = messages.find((message) => message.event === event);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const failure = () =>
          new Error(`Worker did not emit ${event}: ${diagnostic} ${JSON.stringify(messages)}`);
        const timer = setTimeout(() => finish(undefined, failure()), 10_000);
        const onMessage = (message: WorkerMessage) => {
          if (message.event === event) finish(message);
        };
        const onExit = () => finish(undefined, failure());
        const onError = (error: Error) => finish(undefined, error);
        const finish = (message?: WorkerMessage, error?: Error) => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('exit', onExit);
          child.off('error', onError);
          if (error) reject(error);
          else if (message) resolve(message);
        };
        child.on('message', onMessage);
        child.once('exit', onExit);
        child.once('error', onError);
        if (child.exitCode !== null || child.signalCode !== null) onExit();
      });
    },
  };
  workers.push(worker);
  return worker;
}

function installed(): InstalledManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledManifest;
}

beforeEach(() => {
  const temporaryRoot = path.join(workspace, '.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  root = mkdtempSync(path.join(temporaryRoot, 'default-install-process-'));
  pluginsDir = path.join(root, 'plugins');
  manifestPath = path.join(root, 'plugins.json');
  workerPath = path.join(root, 'install-worker.mjs');
  workers = [];
  writeFileSync(path.join(root, '.npmrc'), 'registry=https://registry.test.qianwenai.com/\n');
  writeFileSync(
    manifestPath,
    JSON.stringify({ plugins: [unrelated], disabledDefaults: ['@qianwenai/disabled'] }),
  );
  writeFileSync(
    workerPath,
    `import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
os.homedir = () => config.stateDir;
os.tmpdir = () => config.stateDir;
syncBuiltinESMExports();
const registry = 'https://registry.test.qianwenai.com/';
const metadataUrl = registry + config.definition.name.replace('/', '%2f');
const tarballUrl = registry + 'fixture.tgz';
const archive = fs.readFileSync(config.archivePath);
let fetchCalls = 0;
globalThis.fetch = async (input) => {
  fetchCalls++;
  const url = String(input);
  if (url === metadataUrl) {
    return new Response(JSON.stringify({
      'dist-tags': { latest: config.definition.version },
      versions: {
        [config.definition.version]: {
          qianwen: config.pluginManifest,
          dist: { tarball: tarballUrl, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') },
        },
      },
    }));
  }
  if (url !== tarballUrl) throw new Error('Unexpected network request: ' + url);
  if (config.blockDownload) {
    const released = new Promise((resolve, reject) => {
      process.once('message', (message) => {
        if (message?.event === 'release') resolve();
        else reject(new Error('Unexpected worker message'));
      });
    });
    process.send({ event: 'download-started' });
    await released;
  }
  return new Response(new Uint8Array(archive));
};
try {
  const { ensureDefaultPlugin } = await import(config.serviceUrl);
  process.send({ event: 'started' });
  const record = await ensureDefaultPlugin(config.definition, {
    ...config.context,
    reservedNames: new Set(['models', 'm', 'plugin']),
  });
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

describe('default plugin installation across processes', () => {
  it('recovers a killed download owner and preserves unrelated manifest state', async () => {
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const owner = startWorker(definition('2.0.0'), { blockDownload: true });
    await owner.waitFor('download-started');
    expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest);

    owner.child.kill('SIGKILL');
    expect(await owner.exited).toEqual({ code: null, signal: 'SIGKILL' });
    const contender = startWorker(definition('1.2.3', 'fixture.tgz'));
    const result = await contender.waitFor('result');

    expect(result.error).toBeUndefined();
    expect(result.fetchCalls).toBe(0);
    expect(result.record).toMatchObject({ name: packageName, version: '1.2.3', enabled: true });
    expect(await contender.exited).toEqual({ code: 0, signal: null });
    expect(installed()).toMatchObject({
      plugins: [unrelated, expect.objectContaining({ name: packageName, version: '1.2.3' })],
      disabledDefaults: ['@qianwenai/disabled'],
    });
    const packagePath = path.join(pluginsDir, 'node_modules', packageName, 'package.json');
    expect(JSON.parse(readFileSync(packagePath, 'utf8')).version).toBe('1.2.3');
  }, 20_000);

  it('does not steal a live download owner lock or download before a lock timeout', async () => {
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const owner = startWorker(definition('2.0.0'), { blockDownload: true });
    await owner.waitFor('download-started');
    const contender = startWorker(definition('1.2.3'), { lockTimeoutMs: 150 });
    const result = await contender.waitFor('result');

    expect(result.error).toMatchObject({ code: 'PLUGIN_INSTALL_LOCK_TIMEOUT', exitCode: 4 });
    expect(result.record).toBeUndefined();
    expect(result.fetchCalls).toBe(0);
    expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest);
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();

    owner.child.send({ event: 'release' });
    const ownerResult = await owner.waitFor('result');
    expect(ownerResult.error).toBeUndefined();
    expect(ownerResult.record).toMatchObject({ name: packageName, version: '2.0.0' });
    expect(ownerResult.fetchCalls).toBe(2);
    expect(await owner.exited).toEqual({ code: 0, signal: null });
    expect(installed()).toMatchObject({
      plugins: [unrelated, expect.objectContaining({ name: packageName, version: '2.0.0' })],
      disabledDefaults: ['@qianwenai/disabled'],
    });
  }, 20_000);
});
