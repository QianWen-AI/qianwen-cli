import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

interface LockOptions {
  lockTimeoutMs?: number;
  lockPollMs?: number;
  signal?: AbortSignal;
}

function release(lockPath: string, ownerFile: string): void {
  try {
    fs.unlinkSync(path.join(lockPath, ownerFile));
    fs.rmdirSync(lockPath);
  } catch {
    // Never remove another owner's files or a newly acquired, populated lock.
  }
}

function reapDeadOwner(lockPath: string): void {
  try {
    const files = fs.readdirSync(lockPath);
    if (files.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(files[0])) return;
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, files[0]), 'utf8')) as {
      pid?: unknown;
      token?: unknown;
    };
    if (
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      files[0] !== `owner-${owner.token}.json`
    )
      return;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') release(lockPath, files[0]);
    }
  } catch {
    // Missing or incomplete metadata is not proof that the owner is dead.
  }
}

/** Publish a populated directory atomically so racing stale-lock reapers cannot steal it. */
export async function withManifestLock<T>(
  manifestPath: string,
  options: LockOptions,
  operation: () => Promise<T> | T,
): Promise<T> {
  options.signal?.throwIfAborted();
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const lockPath = `${manifestPath}.lock`;
  const token = randomUUID();
  const ownerFile = `owner-${token}.json`;
  const staging = fs.mkdtempSync(`${lockPath}-`);
  let acquired = false;
  try {
    fs.writeFileSync(path.join(staging, ownerFile), JSON.stringify({ pid: process.pid, token }), {
      mode: 0o600,
    });
    const deadline = Date.now() + (options.lockTimeoutMs ?? 30_000);
    while (!acquired) {
      options.signal?.throwIfAborted();
      try {
        fs.renameSync(staging, lockPath);
        acquired = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
        reapDeadOwner(lockPath);
        if (Date.now() >= deadline) {
          throw new CliError({
            code: 'PLUGIN_INSTALL_LOCK_TIMEOUT',
            message: 'Another plugin operation holds the installation lock. Try again shortly.',
            exitCode: EXIT_CODES.CONFIG_ERROR,
          });
        }
        try {
          await delay(options.lockPollMs ?? 25, undefined, { signal: options.signal });
        } catch (error) {
          options.signal?.throwIfAborted();
          throw error;
        }
      }
    }
    options.signal?.throwIfAborted();
    return await operation();
  } finally {
    if (acquired) release(lockPath, ownerFile);
    else fs.rmSync(staging, { recursive: true, force: true });
  }
}
