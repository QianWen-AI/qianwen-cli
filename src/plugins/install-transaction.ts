import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isRealPathWithinBase } from '../utils/path-safety.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export function isSafePackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name);
}

export interface InstallTransaction {
  name: string;
  version: string;
  pkgDir: string;
  installationId?: string;
  commit(): void;
  rollback(): void;
}

interface InstallJournal {
  schema: 1;
  id: string;
  name: string;
  version: string;
  staging: string;
  hadOld: boolean;
}

interface UninstallJournal {
  schema: 2;
  operation: 'uninstall';
  id: string;
  name: string;
  isDefault: boolean;
}

type PluginJournal = InstallJournal | UninstallJournal;

const journalDirectory = (pluginsDir: string) => path.join(pluginsDir, '.install-transactions');
const journalName = (name: string) => `${createHash('sha256').update(name).digest('hex')}.json`;

function recoveryError(detail: string): CliError {
  return new CliError({
    code: 'PLUGIN_INSTALL_RECOVERY_FAILED',
    message:
      'Could not recover an interrupted plugin operation. Existing files were retained where possible.',
    detail,
    exitCode: EXIT_CODES.CONFIG_ERROR,
    hint: 'Check the plugin installation directory, then retry the command.',
  });
}

function exists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertPath(pluginsDir: string, candidate: string): void {
  if (!isRealPathWithinBase(pluginsDir, candidate))
    throw new Error('installation path escapes plugins directory');
  if (exists(candidate) && fs.lstatSync(candidate).isSymbolicLink())
    throw new Error('installation recovery paths must not be symbolic links');
}

function paths(pluginsDir: string, journal: InstallJournal) {
  const modules = path.join(pluginsDir, 'node_modules');
  const dest = path.join(modules, journal.name);
  return {
    dest,
    backup: `${dest}.qianwen-bak-${journal.id}`,
    staging: path.join(modules, journal.staging),
    file: path.join(journalDirectory(pluginsDir), journalName(journal.name)),
  };
}

function uninstallPaths(pluginsDir: string, journal: UninstallJournal) {
  const dest = path.join(pluginsDir, 'node_modules', journal.name);
  return {
    dest,
    backup: `${dest}.qianwen-uninstall-${journal.id}`,
    file: path.join(journalDirectory(pluginsDir), journalName(journal.name)),
  };
}

/** A pending swap cannot be treated as a healthy installation, even at the same version. */
export function hasPendingPluginInstall(pluginsDir: string, name: string): boolean {
  try {
    const directory = journalDirectory(pluginsDir);
    if (!exists(directory)) return false;
    assertPath(pluginsDir, directory);
    return exists(path.join(directory, journalName(name)));
  } catch {
    return true;
  }
}

export function hasPendingPluginInstalls(pluginsDir: string): boolean {
  try {
    const directory = journalDirectory(pluginsDir);
    if (!exists(directory)) return false;
    assertPath(pluginsDir, directory);
    return fs.readdirSync(directory).some((filename) => filename.endsWith('.json'));
  } catch {
    return true;
  }
}

function remove(candidate: string): void {
  fs.rmSync(candidate, { recursive: true, force: true });
}

function restore(pluginsDir: string, journal: InstallJournal, recorded = true): void {
  const { dest, backup, staging, file } = paths(pluginsDir, journal);
  if (journal.hadOld) {
    if (exists(backup)) {
      remove(dest);
      fs.renameSync(backup, dest);
    } else if (!exists(dest)) {
      throw new Error('both the previous package and its backup are missing');
    }
    // No backup means the initial rename did not happen, or recovery already restored it.
  } else {
    remove(dest);
  }
  remove(staging);
  if (recorded) fs.rmSync(file, { force: true });
}

function finish(pluginsDir: string, journal: InstallJournal, recorded = true): void {
  const { backup, staging, file } = paths(pluginsDir, journal);
  remove(backup);
  remove(staging);
  if (recorded) fs.rmSync(file, { force: true });
}

function readJournal(file: string): PluginJournal {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (
    !value ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.name !== 'string' ||
    !isSafePackageName(value.name) ||
    path.basename(file) !== journalName(value.name)
  )
    throw new Error('invalid installation recovery record');
  if (value.schema === 2 && value.operation === 'uninstall' && typeof value.isDefault === 'boolean')
    return value as unknown as UninstallJournal;
  if (
    value.schema === 1 &&
    typeof value.version === 'string' &&
    typeof value.staging === 'string' &&
    /^\.qianwen-plugin-[a-zA-Z0-9_-]+$/.test(value.staging) &&
    typeof value.hadOld === 'boolean'
  )
    return value as unknown as InstallJournal;
  throw new Error('invalid installation recovery record');
}

function uninstallWasCommitted(manifestPath: string, journal: UninstallJournal): boolean {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    plugins?: unknown;
    disabledDefaults?: unknown;
  } | null;
  if (!manifest || !Array.isArray(manifest.plugins))
    throw new Error('invalid plugin installation manifest');
  if (
    manifest.plugins.some(
      (entry: unknown) =>
        entry && typeof entry === 'object' && 'name' in entry && entry.name === journal.name,
    )
  )
    return false;
  if (
    journal.isDefault &&
    (!Array.isArray(manifest.disabledDefaults) || !manifest.disabledDefaults.includes(journal.name))
  )
    throw new Error('uninstalled default plugin is missing its disabled state');
  return true;
}

function restoreUninstall(pluginsDir: string, journal: UninstallJournal): void {
  const { dest, backup, file } = uninstallPaths(pluginsDir, journal);
  if (exists(backup)) {
    if (exists(dest))
      throw new Error('cannot restore an uninstall backup over an existing package');
    fs.renameSync(backup, dest);
  } else if (!exists(dest)) {
    throw new Error('both the previous package and its uninstall backup are missing');
  }
  fs.rmSync(file, { force: true });
}

function finishUninstall(pluginsDir: string, journal: UninstallJournal): void {
  const { backup, file } = uninstallPaths(pluginsDir, journal);
  remove(backup);
  fs.rmSync(file, { force: true });
}

function wasCommitted(manifestPath: string, journal: InstallJournal): boolean {
  if (!exists(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    plugins?: unknown;
  } | null;
  if (!manifest || !Array.isArray(manifest.plugins))
    throw new Error('invalid plugin installation manifest');
  return manifest.plugins.some((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return (
      record.name === journal.name &&
      record.version === journal.version &&
      record.installationId === journal.id
    );
  });
}

/** Call only while holding the manifest lock; readers never perform recovery writes. */
export function recoverPluginInstalls(pluginsDir: string, manifestPath: string): void {
  const directory = journalDirectory(pluginsDir);
  try {
    if (!exists(directory)) return;
    assertPath(pluginsDir, directory);
    for (const filename of fs.readdirSync(directory).sort()) {
      if (!filename.endsWith('.json')) continue;
      const file = path.join(directory, filename);
      assertPath(pluginsDir, file);
      const journal = readJournal(file);
      if (journal.schema === 2) {
        for (const candidate of Object.values(uninstallPaths(pluginsDir, journal)))
          assertPath(pluginsDir, candidate);
        if (uninstallWasCommitted(manifestPath, journal)) finishUninstall(pluginsDir, journal);
        else restoreUninstall(pluginsDir, journal);
        continue;
      }
      const transactionPaths = paths(pluginsDir, journal);
      for (const candidate of Object.values(transactionPaths)) assertPath(pluginsDir, candidate);
      if (wasCommitted(manifestPath, journal)) {
        assertPath(pluginsDir, path.join(transactionPaths.dest, 'package.json'));
        const metadata = JSON.parse(
          fs.readFileSync(path.join(transactionPaths.dest, 'package.json'), 'utf8'),
        ) as { name?: unknown; version?: unknown };
        if (metadata.name !== journal.name || metadata.version !== journal.version)
          throw new Error('committed package no longer matches its installation record');
        finish(pluginsDir, journal);
      } else {
        restore(pluginsDir, journal);
      }
    }
  } catch (error) {
    throw recoveryError(error instanceof Error ? error.message : String(error));
  }
}

function writeJournal(pluginsDir: string, journal: PluginJournal): void {
  const directory = journalDirectory(pluginsDir);
  assertPath(pluginsDir, directory);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, journalName(journal.name));
  if (exists(file))
    throw new Error('an interrupted installation must be recovered before replacing this plugin');
  const temporary = `${file}.${journal.id}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(journal));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

/** The caller holds the manifest lock and commits its removal before cleaning the backup. */
export function deactivatePlugin(
  name: string,
  pluginsDir: string,
  isDefault: boolean,
): Pick<InstallTransaction, 'commit' | 'rollback'> {
  if (!isSafePackageName(name)) throw new Error('unsafe package name');
  const journal: UninstallJournal = {
    schema: 2,
    operation: 'uninstall',
    id: randomUUID(),
    name,
    isDefault,
  };
  const { dest, backup } = uninstallPaths(pluginsDir, journal);
  assertPath(pluginsDir, dest);
  assertPath(pluginsDir, backup);
  writeJournal(pluginsDir, journal);
  try {
    fs.renameSync(dest, backup);
  } catch (error) {
    restoreUninstall(pluginsDir, journal);
    throw error;
  }
  let settled = false;
  return {
    commit() {
      if (settled) return;
      settled = true;
      try {
        finishUninstall(pluginsDir, journal);
      } catch {
        // Keep the journal so recovery can finish cleanup after the manifest commit.
      }
    },
    rollback() {
      if (settled) return;
      restoreUninstall(pluginsDir, journal);
      settled = true;
    },
  };
}

export function activateStagedPlugin(
  name: string,
  version: string,
  pluginsDir: string,
  staging: string,
  recoverable: boolean,
): InstallTransaction {
  const dest = path.join(pluginsDir, 'node_modules', name);
  const journal: InstallJournal = {
    schema: 1,
    id: randomUUID(),
    name,
    version,
    staging: path.basename(staging),
    hadOld: exists(dest),
  };
  const transactionPaths = paths(pluginsDir, journal);
  for (const candidate of [dest, transactionPaths.backup, staging])
    assertPath(pluginsDir, candidate);
  if (recoverable) writeJournal(pluginsDir, journal);
  try {
    if (journal.hadOld) fs.renameSync(dest, transactionPaths.backup);
    fs.renameSync(staging, dest);
  } catch (error) {
    restore(pluginsDir, journal, recoverable);
    throw error;
  }
  let settled = false;
  return {
    name,
    version,
    pkgDir: dest,
    ...(recoverable ? { installationId: journal.id } : {}),
    commit() {
      if (settled) return;
      settled = true;
      try {
        finish(pluginsDir, journal, recoverable);
      } catch {
        // The manifest is committed. Keep the journal so a later operation can finish cleanup.
      }
    },
    rollback() {
      if (settled) return;
      restore(pluginsDir, journal, recoverable);
      settled = true;
    },
  };
}
