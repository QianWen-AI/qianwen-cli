import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.plugins-local');
const binary = join(local, 'cli/bin/qianwen.js');
const require = createRequire(import.meta.url);
const abort = new AbortController();
const interrupt = () => abort.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

function declaredBinary(packageJson: string, name: string): string {
  const metadata = JSON.parse(readFileSync(packageJson, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const entry = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[name];
  if (!entry) throw new Error(`${name} does not declare a binary.`);
  return resolve(dirname(packageJson), entry);
}

function run(args: string[], cwd: string, env = process.env): Promise<number> {
  abort.signal.throwIfAborted();
  return new Promise((fulfill, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      killTimer.unref();
    };
    abort.signal.addEventListener('abort', stop, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      abort.signal.removeEventListener('abort', stop);
      fulfill(abort.signal.aborted ? 130 : (code ?? 1));
    });
    if (abort.signal.aborted) stop();
  });
}

async function checked(args: string[], cwd: string, env = process.env) {
  const code = await run(args, cwd, env);
  if (code !== 0) throw new Error(`Local plugin preview failed with exit code ${code}.`);
}

async function prepare() {
  await mkdir(local, { recursive: true });
  const lockPath = join(local, 'preview.lock');
  const lock = await open(lockPath, 'wx').catch(() => {
    throw new Error(`Another preview build may be running. Check ${lockPath}.`);
  });
  let staging: string | undefined;
  try {
    await lock.writeFile(String(process.pid));
    staging = await mkdtemp(join(local, 'preview-'));
    const output = join(staging, 'cli');
    await checked([declaredBinary(require.resolve('tsup/package.json'), 'tsup')], root, {
      ...process.env,
      TSUP_MODE: 'development',
      QIANWEN_BUILD_OUTDIR: output,
    });
    await checked([join(output, 'bin/qianwen.js'), 'plugin', 'list', '--format', 'json'], staging, {
      ...process.env,
      QIANWEN_CONFIG_DIR: join(staging, 'smoke-config'),
      QIANWEN_KEYRING: 'no',
    });
    abort.signal.throwIfAborted();
    const previous = join(staging, 'previous-cli');
    const current = join(local, 'cli');
    const hadPrevious = existsSync(current);
    if (hadPrevious) await rename(current, previous);
    try {
      await rename(output, current);
    } catch (error) {
      if (hadPrevious) await rename(previous, current);
      throw error;
    }
    console.log(
      `Local plugin preview ready: ${binary}\nRun: pnpm plugins:preview -- <CLI arguments>`,
    );
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

try {
  const [mode, ...rest] = process.argv.slice(2);
  const args = rest[0] === '--' ? rest.slice(1) : rest;
  if (mode === 'prepare' && args.length === 0) await prepare();
  else if (mode === 'run') {
    if (!existsSync(binary)) throw new Error('Build the local preview first: pnpm plugins:prepare');
    const directory = join(local, 'workspace');
    const config = process.env.QIANWEN_CONFIG_DIR ?? join(local, 'config');
    await mkdir(directory, { recursive: true });
    await mkdir(config, { recursive: true });
    process.exitCode = await run([binary, ...args], directory, {
      ...process.env,
      QIANWEN_CONFIG_DIR: config,
      QIANWEN_KEYRING: 'no',
      QIANWEN_PLUGIN_ARCHIVE_ROOT: root,
    });
  } else throw new Error('Usage: pnpm plugins:prepare | pnpm plugins:preview -- <CLI arguments>');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = abort.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
