/** Download, verify and install registry or local plugins; manage installed artifacts. */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { extractTarballTo, TarReadError } from '../utils/tar-reader.js';
import { resolveRegistryForPackage, type RegistryTarget } from './npm-registry.js';
import type { InstalledPlugin } from './manifest.js';
import {
  isPrereleasePluginVersion,
  isValidPluginVersion,
  type PluginCompatibilityMetadata,
} from './compatibility.js';
import { isRealPathWithinBase } from '../utils/path-safety.js';
import { formatCmd } from '../utils/runtime-mode.js';

import {
  activateStagedPlugin,
  isSafePackageName,
  type InstallTransaction,
} from './install-transaction.js';
export { isSafePackageName, type InstallTransaction } from './install-transaction.js';

export { isSemVerGreater } from '../utils/semver.js';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DIST_TAG_LATEST = 'latest';
// Bound metadata and archive downloads before buffering; extraction has separate size limits.
const MAX_PACKUMENT_BYTES = 16 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
/** Cap on manually followed redirects; every hop is re-validated. */
const MAX_REDIRECTS = 5;

export type InstallResult =
  | {
      ok: true;
      tx: InstallTransaction;
      registryVersions?: Record<string, PackumentVersion>;
    }
  | { ok: false; error: string; cliError?: CliError };

export interface InstallDeps {
  /** Injectable fetch for tests; defaults to the global implementation. */
  fetchImpl?: typeof fetch;
  downloadTimeoutMs?: number;
  registry?: string;
  signal?: AbortSignal;
  recoverable?: boolean;
}

function prepareInstallParent(pluginsDir: string, name?: string): string {
  mkdirSync(pluginsDir, { recursive: true });
  const modulesRoot = join(pluginsDir, 'node_modules');
  if (!isRealPathWithinBase(pluginsDir, modulesRoot)) {
    throw new Error('plugin node_modules escapes the plugins directory');
  }
  mkdirSync(modulesRoot, { recursive: true });
  if (name) {
    const parent = dirname(join(modulesRoot, name));
    if (!isRealPathWithinBase(modulesRoot, parent)) {
      throw new Error('plugin scope directory escapes node_modules');
    }
    mkdirSync(parent, { recursive: true });
  }
  return modulesRoot;
}

/**
 * Split a package spec at the version/tag suffix, preserving a leading scope.
 */
export function parseNpmSpec(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec };
  const version = spec.slice(at + 1);
  const name = spec.slice(0, at);
  return version ? { name, version } : { name };
}

export interface PackumentVersion extends PluginCompatibilityMetadata {
  dist?: { tarball?: string; integrity?: string };
}

interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
}

export interface RegistryPluginMetadata {
  latest: string;
  versions: Record<string, PackumentVersion>;
}

/**
 * Preserve CliError.detail so result strings include the underlying failure.
 */
function toResultError(error: unknown): string {
  if (error instanceof CliError && error.detail) return `${error.message} (${error.detail})`;
  return error instanceof Error ? error.message : String(error);
}

function installFailure(error: unknown): InstallResult {
  return {
    ok: false,
    error: toResultError(error),
    ...(error instanceof CliError ? { cliError: error } : {}),
  };
}

/**
 * Install a registry package by direct HTTPS download with integrity verification.
 * Registry settings come from user-level ~/.npmrc; expected failures return an error result.
 */
export async function installNpmPlugin(
  spec: string,
  pluginsDir: string,
  deps: InstallDeps = {},
): Promise<InstallResult> {
  deps.signal?.throwIfAborted();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  const { name, version: requested } = parseNpmSpec(spec);
  if (!isSafePackageName(name)) {
    return { ok: false, error: `unsafe package name "${name}"` };
  }

  const target = resolveRegistryForPackage(name, undefined, deps.registry);
  let packument: Packument;
  try {
    packument = await fetchPackument(name, target, fetchImpl, timeoutMs, deps.signal);
  } catch (error) {
    return installFailure(error);
  }

  const resolved = resolveVersion(packument, requested);
  if (!resolved) {
    const label = requested ?? DIST_TAG_LATEST;
    return { ok: false, error: `no matching version for "${name}@${label}"` };
  }
  if (!requested && isPrereleasePluginVersion(resolved)) {
    return installFailure(
      new CliError({
        code: 'PLUGIN_PRERELEASE_REQUIRES_EXPLICIT_VERSION',
        message: `The latest version of "${name}" is a prerelease. Specify an explicit version or tag to install it.`,
        exitCode: EXIT_CODES.CONFIG_ERROR,
        hint: `Run: ${formatCmd(`plugin install ${name}@${resolved}`)}`,
      }),
    );
  }
  const dist = packument.versions?.[resolved]?.dist;
  const tarballUrl = dist?.tarball;
  if (!tarballUrl) {
    return { ok: false, error: `registry did not provide a tarball URL for "${name}@${resolved}"` };
  }
  // Registry metadata may be untrusted; tarball URLs must use HTTPS and the registry origin.
  const tarballError = validateRegistryUrl(tarballUrl, target.registry, 'tarball');
  if (tarballError) {
    return { ok: false, error: tarballError };
  }

  let tgz: Buffer;
  try {
    tgz = await downloadBuffer(tarballUrl, target, fetchImpl, timeoutMs, deps.signal);
  } catch (error) {
    return installFailure(error);
  }

  const integrityError = verifyIntegrity(tgz, dist?.integrity);
  if (integrityError) {
    return { ok: false, error: integrityError };
  }
  deps.signal?.throwIfAborted();

  const modulesRoot = join(pluginsDir, 'node_modules');
  const dest = join(modulesRoot, name);
  if (!isWithinBase(modulesRoot, dest)) {
    return { ok: false, error: `package name "${name}" escapes the plugins directory` };
  }

  // Stage on the destination filesystem for atomic renames; retain the old package for rollback.
  try {
    prepareInstallParent(pluginsDir, name);
  } catch (error) {
    return installFailure(error);
  }
  const staging = mkdtempSync(join(modulesRoot, '.qianwen-plugin-'));
  try {
    extractTarballTo(tgz, staging);
    const tx = activateStagedPlugin(name, resolved, pluginsDir, staging, deps.recoverable ?? false);
    return { ok: true, tx, registryVersions: packument.versions ?? {} };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error instanceof TarReadError)
      return { ok: false, error: `refusing to install "${name}": ${error.message}` };
    return installFailure(error);
  }
}

/**
 * Copy a local plugin into storage; reinstall after rebuilding to update the copy.
 */
export function installLocalPlugin(
  srcDir: string,
  pluginsDir: string,
  options: { recoverable?: boolean } = {},
): InstallResult {
  const pkgPath = join(srcDir, 'package.json');
  if (!existsSync(pkgPath)) {
    return { ok: false, error: `no package.json in ${srcDir}` };
  }
  let name: string;
  let version: string;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
    if (!parsed.name) return { ok: false, error: 'package.json missing "name"' };
    name = parsed.name;
    version = parsed.version ?? '0.0.0';
  } catch {
    return { ok: false, error: 'package.json is not valid JSON' };
  }
  if (!isSafePackageName(name)) {
    return { ok: false, error: `unsafe package name "${name}"` };
  }
  const modulesRoot = join(pluginsDir, 'node_modules');
  const dest = join(modulesRoot, name);
  if (!isWithinBase(modulesRoot, dest)) {
    return { ok: false, error: `package name "${name}" escapes the plugins directory` };
  }
  try {
    prepareInstallParent(pluginsDir, name);
  } catch (error) {
    return installFailure(error);
  }
  const staging = mkdtempSync(join(modulesRoot, '.qianwen-plugin-'));
  try {
    let bytes = 0;
    let entries = 0;
    cpSync(srcDir, staging, {
      recursive: true,
      filter: (source) => {
        if (source !== srcDir && ['node_modules', '.git'].includes(basename(source))) return false;
        const stat = lstatSync(source);
        bytes += stat.size;
        entries += 1;
        if (bytes > 100 * 1024 * 1024 || entries > 10_000) {
          throw new Error('local plugin exceeds copy limit (100 MiB or 10000 entries)');
        }
        return true;
      },
    });
    return {
      ok: true,
      tx: activateStagedPlugin(name, version, pluginsDir, staging, options.recoverable ?? false),
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return installFailure(error);
  }
}

export interface ArchiveInstallOptions {
  recoverable?: boolean;
  sha256?: string;
  expectedName?: string;
  expectedVersion?: string;
}

function readArchiveFile(archivePath: string): Buffer {
  // Check the opened target, not the symlink inode; nonblocking open also avoids FIFO hangs.
  const fd = openSync(archivePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('local plugin archive must be a regular file');
    if (stat.size > MAX_TARBALL_BYTES) {
      throw new Error('local plugin archive exceeds the 64 MiB download limit');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > stat.size) throw new Error('local plugin archive changed while reading; retry');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Local archives use the same staging and rollback contract as registry packages. */
export function installArchivePlugin(
  archivePath: string,
  pluginsDir: string,
  options: ArchiveInstallOptions = {},
): InstallResult {
  let staging: string | undefined;
  try {
    const bytes = readArchiveFile(archivePath);
    if (
      options.sha256 !== undefined &&
      (!/^[0-9a-f]{64}$/i.test(options.sha256) ||
        createHash('sha256').update(bytes).digest('hex') !== options.sha256.toLowerCase())
    ) {
      throw new Error('local plugin archive SHA-256 mismatch');
    }
    const modulesRoot = prepareInstallParent(pluginsDir);
    staging = mkdtempSync(join(modulesRoot, '.qianwen-plugin-'));
    extractTarballTo(bytes, staging);
    const metadata = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof metadata.name !== 'string' || !isSafePackageName(metadata.name)) {
      throw new Error('local plugin archive has an unsafe or missing package name');
    }
    if (typeof metadata.version !== 'string' || !isValidPluginVersion(metadata.version)) {
      throw new Error(
        'local plugin archive has invalid package.version: expected a version string',
      );
    }
    if (
      (options.expectedName !== undefined && options.expectedName !== metadata.name) ||
      (options.expectedVersion !== undefined && options.expectedVersion !== metadata.version)
    ) {
      throw new Error('local plugin archive does not match its configured name and version');
    }
    prepareInstallParent(pluginsDir, metadata.name);
    const tx = activateStagedPlugin(
      metadata.name,
      metadata.version,
      pluginsDir,
      staging,
      options.recoverable ?? false,
    );
    staging = undefined;
    return { ok: true, tx };
  } catch (error) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    return installFailure(error);
  }
}

/**
 * Resolve dist-tags.latest; return null if the registry or tag is unavailable.
 */
export async function getRegistryVersion(
  pkg: string,
  deps: InstallDeps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const target = resolveRegistryForPackage(pkg, undefined, deps.registry);
  try {
    const packument = await fetchPackument(pkg, target, fetchImpl, timeoutMs, deps.signal);
    const latest = packument['dist-tags']?.[DIST_TAG_LATEST];
    return latest ? latest.trim() || null : null;
  } catch {
    return null;
  }
}

export async function getRegistryPluginMetadata(
  pkg: string,
  deps: InstallDeps = {},
): Promise<RegistryPluginMetadata | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const target = resolveRegistryForPackage(pkg, undefined, deps.registry);
  try {
    const packument = await fetchPackument(pkg, target, fetchImpl, timeoutMs, deps.signal);
    const latest = packument['dist-tags']?.[DIST_TAG_LATEST]?.trim();
    if (!latest || !packument.versions?.[latest]) return null;
    return { latest, versions: packument.versions };
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT_CODES.AUTH_FAILURE) throw error;
    return null;
  }
}

/**
 * Remove managed package copies; link/bundle source directories remain untouched.
 */
export function removePluginArtifacts(plugin: InstalledPlugin, pluginsDir: string): void {
  if (plugin.source === 'npm' || plugin.source === 'local') {
    const dest = plugin.path ?? join(pluginsDir, 'node_modules', plugin.name);
    const modulesRoot = join(pluginsDir, 'node_modules');
    // Delete only children of node_modules, never its root or paths outside it.
    if (isStrictlyWithinBase(modulesRoot, dest)) {
      rmSync(dest, { recursive: true, force: true });
    }
  }
  // link/bundle: no artifact deletion (source dir is not ours to remove).
}

/** Resolve a requested spec version/tag to a concrete published version. */
function resolveVersion(packument: Packument, requested: string | undefined): string | null {
  const versions = packument.versions ?? {};
  const tags = packument['dist-tags'] ?? {};
  if (!requested) {
    return tags[DIST_TAG_LATEST] ?? null;
  }
  if (versions[requested]) return requested;
  // A dist-tag such as `latest`, `next` or `beta`.
  const tagged = tags[requested];
  return tagged && versions[tagged] ? tagged : null;
}

async function fetchPackument(
  pkg: string,
  target: RegistryTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Packument> {
  // Scoped names keep their slash encoded per the npm registry API convention.
  const url = target.registry + pkg.replace('/', '%2f');
  const buf = await fetchWithTimeout(
    url,
    target,
    fetchImpl,
    timeoutMs,
    MAX_PACKUMENT_BYTES,
    'registry metadata',
    signal,
  );
  try {
    return JSON.parse(buf.toString('utf8')) as Packument;
  } catch {
    throw new CliError({
      code: 'PLUGIN_INSTALL_FAILED',
      message: `registry returned invalid metadata for "${pkg}".`,
      exitCode: EXIT_CODES.NETWORK_ERROR,
    });
  }
}

async function downloadBuffer(
  url: string,
  target: RegistryTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return fetchWithTimeout(
    url,
    target,
    fetchImpl,
    timeoutMs,
    MAX_TARBALL_BYTES,
    'plugin tarball',
    signal,
  );
}

async function fetchWithTimeout(
  url: string,
  target: RegistryTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
  what: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Validate HTTPS and origin before sending credentials, including every redirect hop.
    const initialError = validateRegistryUrl(url, target.registry, what);
    if (initialError) {
      throw new CliError({
        code: 'PLUGIN_INSTALL_FAILED',
        message: `Refusing to fetch ${what}: ${initialError}`,
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
    }
    let currentUrl = url;
    let response: Awaited<ReturnType<typeof fetch>>;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {};
      // Credentials must never leave the registry origin.
      if (target.authToken && currentUrl.startsWith(target.registry)) {
        headers.Authorization = `Bearer ${target.authToken}`;
      }
      const res = await fetchImpl(currentUrl, {
        signal: controller.signal,
        headers,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new CliError({
            code: 'PLUGIN_INSTALL_FAILED',
            message: `Failed to fetch ${what}: redirect without a Location header.`,
            exitCode: EXIT_CODES.NETWORK_ERROR,
          });
        }
        if (hop >= MAX_REDIRECTS) {
          throw new CliError({
            code: 'PLUGIN_INSTALL_FAILED',
            message: `Failed to fetch ${what}: too many redirects (> ${MAX_REDIRECTS}).`,
            exitCode: EXIT_CODES.NETWORK_ERROR,
          });
        }
        const nextUrl = new URL(location, currentUrl).toString();
        const hopError = validateRegistryUrl(nextUrl, target.registry, what);
        if (hopError) {
          throw new CliError({
            code: 'PLUGIN_INSTALL_FAILED',
            message: `Refusing to follow redirect for ${what}: ${hopError}`,
            exitCode: EXIT_CODES.NETWORK_ERROR,
          });
        }
        currentUrl = nextUrl;
        continue;
      }
      response = res;
      break;
    }
    if (!response.ok) {
      throw new CliError({
        code: 'PLUGIN_INSTALL_FAILED',
        message: `Failed to fetch ${what} (HTTP ${response.status}).`,
        exitCode:
          response.status === 401 || response.status === 403
            ? EXIT_CODES.AUTH_FAILURE
            : EXIT_CODES.NETWORK_ERROR,
      });
    }
    // Enforce the cap while streaming even when Content-Length is absent or incorrect.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw sizeLimitError(what, maxBytes);
    }
    return await readCapped(response, maxBytes, what);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CliError) throw error;
    const timedOut = error instanceof Error && error.name === 'AbortError';
    throw new CliError({
      code: 'PLUGIN_INSTALL_FAILED',
      message: timedOut ? `Timed out fetching ${what}.` : `Failed to fetch ${what}.`,
      exitCode: EXIT_CODES.NETWORK_ERROR,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function sizeLimitError(what: string, maxBytes: number): CliError {
  return new CliError({
    code: 'PLUGIN_INSTALL_FAILED',
    message: `${what} exceeds the ${maxBytes / (1024 * 1024)} MiB size limit.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

/**
 * Abort response buffering as soon as the running total exceeds maxBytes.
 */
async function readCapped(response: Response, maxBytes: number, what: string): Promise<Buffer> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw sizeLimitError(what, maxBytes);
    return Buffer.from(bytes);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw sizeLimitError(what, maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Require matching sha256/sha512 integrity; missing, malformed or weaker digests fail closed.
 * Return an error string, or null only on a verified match.
 */
const STRONG_INTEGRITY_ALGORITHMS = new Set(['sha256', 'sha512']);

function verifyIntegrity(tgz: Buffer, integrity?: string): string | null {
  if (!integrity) return 'the registry did not provide an integrity checksum.';
  const match = /^([a-z0-9]+)-(.+)$/.exec(integrity.trim());
  if (!match) return `malformed integrity value: ${integrity}`;
  const [, algorithm, expected] = match;
  if (!STRONG_INTEGRITY_ALGORITHMS.has(algorithm)) {
    return `unsupported integrity algorithm "${algorithm}" (require sha256 or sha512)`;
  }
  const actual = createHash(algorithm).update(tgz).digest('base64');
  return actual === expected ? null : `integrity mismatch (${algorithm}).`;
}

/** True when `dest` is the base itself or lives strictly inside it. */
function isWithinBase(base: string, dest: string): boolean {
  const b = resolve(base);
  const d = resolve(dest);
  return d === b || d.startsWith(b + sep);
}

/** True only when `dest` lives strictly inside `base` (never equal to it). */
function isStrictlyWithinBase(base: string, dest: string): boolean {
  return resolve(dest).startsWith(resolve(base) + sep);
}

/**
 * Require HTTPS and the registry origin for initial URLs and every redirect.
 * Return an error string, or null when the URL satisfies both constraints.
 */
function validateRegistryUrl(url: string, registry: string, what: string): string | null {
  let target: URL;
  let reg: URL;
  try {
    target = new URL(url);
    reg = new URL(registry);
  } catch {
    return `invalid ${what} URL: ${url}`;
  }
  if (target.protocol !== 'https:') {
    return `refusing non-https ${what} URL: ${url}`;
  }
  if (target.origin !== reg.origin) {
    return `${what} URL origin (${target.origin}) does not match the registry (${reg.origin})`;
  }
  return null;
}
