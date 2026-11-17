import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expandHomePath, isHomePath } from '../utils/expand-home.js';
import { getDefaultPlugins, type DefaultPlugin } from './defaults.js';
import {
  readInstalledManifest,
  parsePluginPackageManifest,
  validateManifest,
  writeInstalledManifest,
  type InstalledManifest,
  type InstalledPlugin,
  type PluginManifest,
} from './manifest.js';
import {
  installArchivePlugin,
  installLocalPlugin,
  installNpmPlugin,
  isSafePackageName,
  parseNpmSpec,
  type InstallResult,
} from './installer.js';
import { isOfficialPlugin } from './allowlist.js';
import {
  comparePluginVersions,
  isCliVersionCompatible,
  isPrereleasePluginVersion,
  isValidPluginVersion,
  resolveHighestCompatiblePluginVersion,
} from './compatibility.js';
import { normalizeCommandName, pluginNames, resolvePluginConflict } from './names.js';
import { withManifestLock } from './manifest-lock.js';
import {
  deactivatePlugin,
  hasPendingPluginInstall,
  hasPendingPluginInstalls,
  recoverPluginInstalls,
} from './install-transaction.js';
import { isRealPathWithinBase, resolveWithinBase } from '../utils/path-safety.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { formatCmd } from '../utils/runtime-mode.js';
import { PluginCliIncompatibleError } from './errors.js';

export interface DefaultInstallContext {
  pluginsDir: string;
  manifestPath: string;
  cliVersion: string;
  reservedNames?: Set<string>;
  definitions?: readonly DefaultPlugin[];
  archiveRoot?: string;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  signal?: AbortSignal;
}

export interface UsableDefaultPlugin {
  record: InstalledPlugin;
  pkgDir: string;
  manifest: PluginManifest;
}

function rejected(message: string): CliError {
  return new CliError({
    code: 'INVALID_ARGUMENT',
    message,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

export function isLocalPluginPath(spec: string): boolean {
  return (
    isHomePath(spec) ||
    /^(?:\.\.?[\\/]|[\\/]|[a-zA-Z]:[\\/])/.test(spec) ||
    spec === '.' ||
    spec === '..'
  );
}

function definitions(context: DefaultInstallContext): readonly DefaultPlugin[] {
  return context.definitions ?? getDefaultPlugins();
}

function managedPackageDir(record: InstalledPlugin, context: DefaultInstallContext): string {
  const modulesRoot = path.join(context.pluginsDir, 'node_modules');
  const expected = path.join(modulesRoot, record.name);
  const candidate = record.path ?? expected;
  if (
    !isSafePackageName(record.name) ||
    path.resolve(candidate) !== path.resolve(expected) ||
    !isRealPathWithinBase(context.pluginsDir, modulesRoot) ||
    !isRealPathWithinBase(modulesRoot, candidate)
  )
    throw rejected('plugin package path escapes the managed installation directory');
  return candidate;
}

function resolvedOwners(
  state: InstalledManifest,
  context: DefaultInstallContext,
  excludedName: string,
): InstalledPlugin[] {
  return state.plugins
    .filter((record) => record.name !== excludedName)
    .map((record) => {
      if (record.command !== undefined && record.commandAliases !== undefined) return record;
      let manifest: PluginManifest | null = null;
      try {
        manifest = withCommittedPackageMetadata(record, context, state, (_pkgDir, metadata) => {
          const packageInfo = metadata as { name?: unknown; version?: unknown } | null;
          if (packageInfo?.name !== record.name || packageInfo?.version !== record.version)
            return null;
          const parsed = parsePluginPackageManifest(metadata);
          return parsed && !validateManifest(parsed) ? parsed : null;
        });
      } catch {
        // Retain recorded ownership when a legacy package cannot be inspected safely.
      }
      return {
        ...record,
        command: record.command ?? manifest?.command,
        commandAliases: record.commandAliases ?? manifest?.commandAliases,
      };
    });
}

export function validateInstalledPlugin(
  record: InstalledPlugin,
  context: DefaultInstallContext,
  state: InstalledManifest,
  definition?: DefaultPlugin,
): UsableDefaultPlugin {
  const pkgDir = managedPackageDir(record, context);
  const packageFile = path.join(pkgDir, 'package.json');
  if (!isRealPathWithinBase(pkgDir, packageFile))
    throw rejected('package.json escapes the package directory');
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  return validateInstalledMetadata(record, context, state, pkgDir, metadata, definition);
}

function validateInstalledMetadata(
  record: InstalledPlugin,
  context: DefaultInstallContext,
  state: InstalledManifest,
  pkgDir: string,
  metadata: unknown,
  definition?: DefaultPlugin,
): UsableDefaultPlugin {
  const packageInfo = metadata as { name?: unknown; version?: unknown } | null;
  if (typeof packageInfo?.version !== 'string' || !isValidPluginVersion(packageInfo.version)) {
    throw rejected('invalid package.version: expected a valid version string');
  }
  if (
    packageInfo?.name !== record.name ||
    packageInfo?.version !== record.version ||
    !isValidPluginVersion(record.version)
  )
    throw rejected('plugin package name/version does not match its installation metadata');
  const manifest = parsePluginPackageManifest(metadata);
  if (!manifest) throw rejected(`installed package has no plugin manifest (${pkgDir})`);
  const invalid = validateManifest(manifest);
  if (invalid) throw rejected(invalid);
  if (manifest.minCliVersion !== undefined && !isValidPluginVersion(manifest.minCliVersion)) {
    throw rejected(`invalid minCliVersion "${manifest.minCliVersion}"`);
  }
  if (
    manifest.minCliVersion !== undefined &&
    !isCliVersionCompatible(context.cliVersion, manifest.minCliVersion)
  ) {
    throw new PluginCliIncompatibleError(manifest.minCliVersion, context.cliVersion);
  }
  const entry = manifest.entry && resolveWithinBase(pkgDir, manifest.entry);
  let validEntry = false;
  if (entry && isRealPathWithinBase(pkgDir, entry)) {
    try {
      validEntry = fs.statSync(entry).isFile();
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  if (!validEntry) {
    throw new CliError({
      code: 'PLUGIN_ENTRY_INVALID',
      message: `Plugin "${record.name}" entry "${manifest.entry}" is missing, is not a file, or escapes the package directory.`,
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  }
  const command = normalizeCommandName(manifest.command);
  const names = pluginNames(manifest.command, manifest.commandAliases);
  if (
    (record.command !== undefined && normalizeCommandName(record.command) !== command) ||
    (record.commandAliases !== undefined &&
      JSON.stringify(pluginNames('', record.commandAliases).sort()) !==
        JSON.stringify(pluginNames('', manifest.commandAliases).sort()))
  )
    throw rejected('plugin command metadata does not match its package manifest');
  if (resolvePluginConflict(names, context.reservedNames ?? new Set(), []) === 'reserved') {
    throw rejected(`command/alias "${command}" is reserved by a built-in command`);
  }
  const others = resolvedOwners(state, context, record.name);
  if (
    others.some((owner) =>
      pluginNames(owner.command ?? '', owner.commandAliases).some((name) => names.includes(name)),
    )
  ) {
    throw rejected(`command/alias "${command}" is already provided by another plugin`);
  }
  for (const configured of definitions(context)) {
    if (configured.name === record.name) continue;
    if (
      pluginNames(configured.command, configured.commandAliases).some((name) =>
        names.includes(name),
      )
    ) {
      throw rejected(`command/alias "${command}" is already provided by another default plugin`);
    }
  }
  if (definition) {
    const required = pluginNames(definition.command, definition.commandAliases);
    if (
      command !== normalizeCommandName(definition.command) ||
      required.some((name) => !names.includes(name))
    ) {
      throw rejected('default plugin must retain its configured command and aliases');
    }
  }
  return { record, pkgDir, manifest };
}

function samePackageFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function withCommittedPackageMetadata<T>(
  record: InstalledPlugin,
  context: DefaultInstallContext,
  state: InstalledManifest,
  inspect: (pkgDir: string, metadata: unknown) => T,
): T | null {
  if (hasPendingPluginInstall(context.pluginsDir, record.name)) return null;
  const pkgDir = managedPackageDir(record, context);
  const packageFile = path.join(pkgDir, 'package.json');
  if (!isRealPathWithinBase(pkgDir, packageFile))
    throw rejected('package.json escapes the package directory');
  const fd = fs.openSync(packageFile, 'r');
  try {
    const snapshot = fs.fstatSync(fd, { bigint: true });
    if (!snapshot.isFile() || snapshot.ino === 0n) return null;
    const metadata: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const inspected = inspect(pkgDir, metadata);
    if (hasPendingPluginInstall(context.pluginsDir, record.name)) return null;
    const current = readInstalledManifest(context.manifestPath);
    if (
      !isDeepStrictEqual(
        current.plugins.find((plugin) => plugin.name === record.name),
        record,
      ) ||
      Boolean(current.disabledDefaults?.includes(record.name)) !==
        Boolean(state.disabledDefaults?.includes(record.name))
    )
      return null;
    managedPackageDir(record, context);
    if (!isRealPathWithinBase(pkgDir, packageFile)) return null;
    // Keep the fd open until this final identity check: rollback may remove the journal
    // while restoring an older package at the same path and version.
    if (
      !samePackageFile(snapshot, fs.fstatSync(fd, { bigint: true })) ||
      !samePackageFile(snapshot, fs.statSync(packageFile, { bigint: true }))
    )
      return null;
    return inspected;
  } finally {
    fs.closeSync(fd);
  }
}

/** Read-only consumers must not accept metadata from an uncommitted replacement. */
export function readCommittedInstalledPlugin(
  record: InstalledPlugin,
  context: DefaultInstallContext,
  state: InstalledManifest,
  definition?: DefaultPlugin,
): UsableDefaultPlugin | null {
  if (
    !record.enabled ||
    state.disabledDefaults?.includes(record.name) ||
    !['npm', 'local', 'archive'].includes(record.source)
  )
    return null;
  return withCommittedPackageMetadata(record, context, state, (pkgDir, metadata) =>
    validateInstalledMetadata(record, context, state, pkgDir, metadata, definition),
  );
}

function usableFromState(
  definition: DefaultPlugin,
  context: DefaultInstallContext,
  state: InstalledManifest,
): UsableDefaultPlugin | null {
  if (state.disabledDefaults?.includes(definition.name)) return null;
  const record = state.plugins.find((plugin) => plugin.name === definition.name);
  if (!record?.enabled || !['npm', 'local', 'archive'].includes(record.source)) return null;
  try {
    return readCommittedInstalledPlugin(record, context, state, definition);
  } catch {
    return null;
  }
}

/** Startup may inspect a healthy user version without writes, downloads, or executable imports. */
export function readUsableDefaultPlugin(
  definition: DefaultPlugin,
  context: DefaultInstallContext,
): UsableDefaultPlugin | null {
  if (hasPendingPluginInstall(context.pluginsDir, definition.name)) return null;
  return usableFromState(definition, context, readInstalledManifest(context.manifestPath));
}

async function commitInstall(
  result: InstallResult,
  source: 'npm' | 'local' | 'archive',
  context: DefaultInstallContext,
  state: InstalledManifest,
  expected?: { name: string; version?: string },
  manualSpec?: string,
): Promise<InstalledPlugin> {
  if (!result.ok)
    throw (
      result.cliError ??
      rejected(`plugin install failed: ${result.error.trim() || 'unknown error'}`)
    );
  const { tx } = result;
  let committed = false;
  try {
    if (
      expected &&
      (tx.name !== expected.name || (expected.version && tx.version !== expected.version))
    ) {
      throw rejected('installed package does not match the requested name and version');
    }
    const definition = definitions(context).find((configured) => configured.name === tx.name);
    const record: InstalledPlugin = {
      name: tx.name,
      version: tx.version,
      enabled: true,
      source,
      ...(tx.installationId ? { installationId: tx.installationId } : {}),
      ...(source === 'local' ? { path: tx.pkgDir } : {}),
    };
    let validated: UsableDefaultPlugin;
    try {
      validated = validateInstalledPlugin(record, context, state, definition);
    } catch (error) {
      const requested = manualSpec && parseNpmSpec(manualSpec).version;
      if (
        error instanceof CliError &&
        error.code === 'PLUGIN_CLI_INCOMPATIBLE' &&
        manualSpec &&
        (!requested || requested === 'latest') &&
        result.registryVersions
      ) {
        const compatible = resolveHighestCompatiblePluginVersion(
          result.registryVersions,
          context.cliVersion,
          tx.version,
          requested === 'latest' && isPrereleasePluginVersion(tx.version),
        );
        if (compatible)
          throw rejected(
            `${error.message}; latest compatible version is ${compatible}. Run: ${formatCmd(`plugin install ${tx.name}@${compatible}`)}`,
          );
      }
      throw error;
    }
    record.command = normalizeCommandName(validated.manifest.command);
    if (validated.manifest.commandAliases)
      record.commandAliases = validated.manifest.commandAliases;
    state.plugins = [...state.plugins.filter((plugin) => plugin.name !== record.name), record];
    if (manualSpec && state.disabledDefaults) {
      state.disabledDefaults = state.disabledDefaults.filter((name) => name !== record.name);
    }
    context.signal?.throwIfAborted();
    writeInstalledManifest(context.manifestPath, state);
    tx.commit();
    committed = true;
    return record;
  } finally {
    if (!committed) tx.rollback();
  }
}

function withInstallRecovery<T>(
  context: DefaultInstallContext,
  operation: () => T | Promise<T>,
): Promise<T> {
  return withManifestLock(context.manifestPath, context, () => {
    recoverPluginInstalls(context.pluginsDir, context.manifestPath);
    context.signal?.throwIfAborted();
    return operation();
  });
}

export async function recoverManagedPluginInstalls(context: DefaultInstallContext): Promise<void> {
  context.signal?.throwIfAborted();
  if (hasPendingPluginInstalls(context.pluginsDir)) await withInstallRecovery(context, () => {});
}

export async function ensureDefaultPlugin(
  definition: DefaultPlugin,
  context: DefaultInstallContext,
): Promise<InstalledPlugin> {
  context.signal?.throwIfAborted();
  const current = readUsableDefaultPlugin(definition, context);
  if (current && (comparePluginVersions(current.record.version, definition.version) ?? -1) >= 0)
    return current.record;
  return withInstallRecovery(context, async () => {
    const state = readInstalledManifest(context.manifestPath);
    if (
      state.disabledDefaults?.includes(definition.name) ||
      state.plugins.some((plugin) => plugin.name === definition.name && !plugin.enabled)
    ) {
      throw new CliError({
        code: 'PLUGIN_DEFAULT_DISABLED',
        message: `Default plugin "${definition.name}" is disabled. Run: ${formatCmd(`plugin install ${definition.name}`)}`,
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    }
    context.signal?.throwIfAborted();
    const existing = state.plugins.find((plugin) => plugin.name === definition.name);
    if (existing) {
      try {
        const usable = validateInstalledPlugin(existing, context, state, definition);
        if ((comparePluginVersions(usable.record.version, definition.version) ?? -1) >= 0)
          return usable.record;
      } catch (error) {
        if (error instanceof CliError && error.code === 'PLUGIN_CLI_INCOMPATIBLE') throw error;
        // Repair damaged installations, while retaining the old package until commit.
      }
    }
    let result: InstallResult;
    if (definition.source.type === 'npm') {
      result = await installNpmPlugin(
        `${definition.name}@${definition.version}`,
        context.pluginsDir,
        { registry: definition.source.registry, signal: context.signal, recoverable: true },
      );
    } else {
      const archive = path.isAbsolute(definition.source.path)
        ? definition.source.path
        : context.archiveRoot && resolveWithinBase(context.archiveRoot, definition.source.path);
      if (!archive)
        throw rejected('relative default plugin archive requires an explicit archive root');
      result = installArchivePlugin(archive, context.pluginsDir, {
        sha256: definition.sha256,
        expectedName: definition.name,
        expectedVersion: definition.version,
        recoverable: true,
      });
    }
    return commitInstall(result, definition.source.type, context, state, definition);
  });
}

export async function installManagedPlugin(
  spec: string,
  context: DefaultInstallContext,
): Promise<InstalledPlugin> {
  if (!spec?.trim()) throw rejected('plugin install requires a package name or local path.');
  spec = expandHomePath(spec);
  const local = isLocalPluginPath(spec);
  const requested = local ? undefined : parseNpmSpec(spec);
  if (requested && (!isSafePackageName(requested.name) || !isOfficialPlugin(requested.name))) {
    throw rejected(
      `"${requested.name}" is not an official plugin and cannot be installed from npm.`,
    );
  }
  return withInstallRecovery(context, async () => {
    const state = readInstalledManifest(context.manifestPath);
    const definition = definitions(context).find((plugin) => plugin.name === requested?.name);
    const result = local
      ? installLocalPlugin(spec, context.pluginsDir, { recoverable: true })
      : await installNpmPlugin(spec, context.pluginsDir, {
          registry: definition?.source.type === 'npm' ? definition.source.registry : undefined,
          signal: context.signal,
          recoverable: true,
        });
    const expected = requested && {
      name: requested.name,
      ...(requested.version && isValidPluginVersion(requested.version)
        ? { version: requested.version }
        : {}),
    };
    return commitInstall(result, local ? 'local' : 'npm', context, state, expected, spec);
  });
}

export async function uninstallManagedPlugin(
  spec: string,
  context: DefaultInstallContext,
): Promise<void> {
  const { name, version } = parseNpmSpec(spec);
  if (!isSafePackageName(name)) throw rejected(`unsafe package name "${name}"`);
  if (version && !isValidPluginVersion(version)) {
    throw rejected(
      `unsupported plugin version spec "${version}"; use a package name or an exact version.`,
    );
  }
  return withInstallRecovery(context, () => {
    const state = readInstalledManifest(context.manifestPath);
    const record = state.plugins.find((plugin) => plugin.name === name);
    const isDefault = definitions(context).some((definition) => definition.name === name);
    if (!record && (!isDefault || version)) throw rejected(`plugin "${name}" is not installed.`);
    if (version && record && comparePluginVersions(version, record.version) !== 0) {
      throw rejected(
        `plugin "${name}@${version}" is not installed (installed version: ${record.version}).`,
      );
    }
    let transaction: ReturnType<typeof deactivatePlugin> | undefined;
    if (record && ['npm', 'local', 'archive'].includes(record.source)) {
      const expected = path.join(context.pluginsDir, 'node_modules', name);
      if (fs.existsSync(expected) || fs.existsSync(path.dirname(expected))) {
        const packageDir = managedPackageDir(record, context);
        if (fs.existsSync(packageDir)) {
          transaction = deactivatePlugin(name, context.pluginsDir, isDefault);
        }
      }
    }
    try {
      state.plugins = state.plugins.filter((plugin) => plugin.name !== name);
      if (isDefault)
        state.disabledDefaults = [...new Set([...(state.disabledDefaults ?? []), name])];
      writeInstalledManifest(context.manifestPath, state);
    } catch (error) {
      transaction?.rollback();
      throw error;
    }
    transaction?.commit();
  });
}
