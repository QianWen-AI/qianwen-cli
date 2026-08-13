/**
 * SkillsInstallService — orchestrates `skills install`:
 *
 *   detail (latest version + security state) → target-directory state check →
 *   download URL → streamed download to a staging temp file → local SHA256 →
 *   safe extraction into a staging directory → atomic rename deployment →
 *   metadata write (deferred until deployment succeeded).
 *
 * Failure at any step rolls the target back to its previous state and removes
 * the staging area — no partial deployments, no stale metadata. An unmanaged
 * same-name directory aborts the whole run before any download starts.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { isSemVerGreater } from '../utils/semver.js';
import { extractZipTo, ZipReadError } from '../utils/zip-reader.js';
import { safeRemove, skillStagingPrefix } from './skills-removal.js';
import { SkillsHubService, securityStatusLabel } from './skills-hub-service.js';
import {
  assessSkillDir,
  decideInstallOutcome,
  skillMetaFileName,
  writeSkillMeta,
} from './skills-state-manager.js';
import type { SkillDirState, SkillMetadataV1, SkillsInstallResult } from '../types/skills.js';

// Version string is injected at build time (tsup define); the literal
// fallback covers test/dev runs without the define replacement.
declare const __VERSION__: string;
const CLIENT_VERSION: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

export interface SkillsInstallOptions {
  slug: string;
  /** Base directory that will contain `<baseDir>/<slug>/`; must exist. */
  baseDir: string;
  downloadTimeoutMs?: number;
  /**
   * Pre-fetched skill detail — when the command layer already validated
   * existence (e.g. before an interactive prompt), pass the result here to
   * skip the redundant `getSkillDetail` network call inside `install()`.
   */
  preloadedDetail?: import('../types/skills.js').SkillDetail;
}

export interface SkillsInstallDeps {
  /** Injectable fetch for tests; defaults to the global implementation. */
  fetchImpl?: typeof fetch;
}

export class SkillsInstallService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly hubService: SkillsHubService,
    deps: SkillsInstallDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async install(options: SkillsInstallOptions): Promise<SkillsInstallResult> {
    const { slug } = options;
    const baseDir = path.resolve(options.baseDir);
    assertBaseDir(baseDir);

    const detail = options.preloadedDetail ?? (await this.hubService.getSkillDetail(slug));
    const securityLabel = securityStatusLabel(detail.securityStatus);
    const version = detail.latestVersion;
    if (!version) {
      throw new CliError({
        code: 'INSTALL_FAILED',
        message: `No published version available for skill '${slug}'.`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    const targetDir = path.join(baseDir, slug);
    const state = assessSkillDir(targetDir);
    if (state.kind === 'unmanaged') {
      throw unmanagedConflictError(slug, targetDir, state);
    }

    const outcome = decideInstallOutcome(state, version);
    // The update proceeds either way; a semver-detectable downgrade is only
    // surfaced as a warning so the user knows the hub release is older.
    const downgrade =
      outcome === 'updated' &&
      state.kind === 'managed' &&
      isSemVerGreater(state.meta.version, version)
        ? { from: state.meta.version, to: version }
        : undefined;
    if (outcome === 'noop') {
      // Same version already installed — zero write operations.
      const recorded = state.kind === 'managed' ? state.meta.sha256 : '';
      return {
        slug,
        version,
        outcome,
        targetDir,
        securityStatus: detail.securityStatus,
        securityLabel,
        sha256: recorded,
      };
    }

    const download = await this.hubService.getSkillDownload(slug, version);

    // Staging lives next to the target so the final rename stays on one
    // filesystem (atomic); the prefix is brand-derived and dot-hidden.
    const staging = fs.mkdtempSync(path.join(baseDir, skillStagingPrefix()));
    try {
      const zipPath = path.join(staging, 'skill.zip');
      await this.downloadToFile(download.ossUrl, zipPath, baseDir, options.downloadTimeoutMs);

      const zipBuffer = fs.readFileSync(zipPath);
      const sha256 = createHash('sha256').update(zipBuffer).digest('hex');

      // Integrity gate: the server must declare a package SHA256 and it must
      // match the locally computed digest — otherwise the zip is removed and
      // nothing is extracted, deployed or recorded.
      const expectedSha256 = (download.sha256 ?? '').trim().toLowerCase();
      if (!expectedSha256) {
        safeRemove(zipPath, { baseDir, expectKind: 'temp-file' });
        throw new CliError({
          code: 'INSTALL_FAILED',
          message: `Download verification failed for '${slug}': the server did not provide a SHA256 checksum.`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
      if (expectedSha256 !== sha256.trim().toLowerCase()) {
        safeRemove(zipPath, { baseDir, expectKind: 'temp-file' });
        throw new CliError({
          code: 'INSTALL_FAILED',
          message: `SHA256 mismatch for '${slug}': expected ${expectedSha256}, got ${sha256}.`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }

      const extractDir = path.join(staging, 'content');
      fs.mkdirSync(extractDir);
      try {
        extractZipTo(zipBuffer, extractDir);
      } catch (error) {
        if (error instanceof ZipReadError) {
          throw new CliError({
            code: 'INSTALL_FAILED',
            message: `Refusing to install '${slug}': ${error.message}`,
            exitCode: EXIT_CODES.GENERAL_ERROR,
          });
        }
        throw error;
      }

      deployAndWriteMeta(extractDir, targetDir, staging, {
        schemaVersion: 1,
        slug,
        version,
        sha256,
        installMethod: 'copy',
        installedAt: new Date().toISOString(),
        clientVersion: CLIENT_VERSION,
      });

      return {
        slug,
        version,
        outcome,
        targetDir,
        securityStatus: detail.securityStatus,
        securityLabel,
        sha256,
        ...(downgrade ? { downgrade } : {}),
      };
    } finally {
      safeRemove(staging, { baseDir, expectKind: 'staging' });
    }
  }

  /** Stream the zip to a temp file; abort on timeout, clean up on failure. */
  private async downloadToFile(
    url: string,
    filePath: string,
    baseDir: string,
    timeoutMs?: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new CliError({
          code: 'DOWNLOAD_FAILED',
          message: `Skill package download failed (HTTP ${response.status}).`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
      if (!response.body) {
        throw new CliError({
          code: 'DOWNLOAD_FAILED',
          message: 'Skill package download failed: empty response body.',
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream),
        fs.createWriteStream(filePath),
      );
    } catch (error) {
      safeRemove(filePath, { baseDir, expectKind: 'temp-file' });
      if (error instanceof CliError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new CliError({
        code: 'DOWNLOAD_FAILED',
        message: timedOut ? 'Skill package download timed out.' : 'Skill package download failed.',
        exitCode: EXIT_CODES.GENERAL_ERROR,
        detail: reason,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertBaseDir(baseDir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(baseDir);
  } catch {
    throw new CliError({
      code: 'INSTALL_FAILED',
      message: `Target directory does not exist: ${baseDir}`,
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });
  }
  if (!stat.isDirectory()) {
    throw new CliError({
      code: 'INSTALL_FAILED',
      message: `Target path is not a directory: ${baseDir}`,
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });
  }
}

function unmanagedConflictError(
  slug: string,
  targetDir: string,
  state: Extract<SkillDirState, { kind: 'unmanaged' }>,
): CliError {
  const base =
    state.reason === 'schema-version-too-new'
      ? `Skill directory '${targetDir}' has metadata written by a newer CLI version. ` +
        'Upgrade the CLI to manage this skill.'
      : `A directory named '${slug}' already exists at '${targetDir}' but is not managed ` +
        `by this CLI (missing or invalid ${skillMetaFileName()}).`;
  return new CliError({
    code: 'UNMANAGED_CONFLICT',
    message: `${base} No changes were made.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

/**
 * Atomically deploy the extracted content over the target and write metadata
 * last. For an update the previous directory is parked inside the staging
 * area and restored if the swap or the metadata write fails.
 */
function deployAndWriteMeta(
  extractDir: string,
  targetDir: string,
  staging: string,
  meta: SkillMetadataV1,
): void {
  const backupDir = path.join(staging, 'previous');
  const hadPrevious = fs.existsSync(targetDir);

  if (hadPrevious) {
    fs.renameSync(targetDir, backupDir);
  }
  try {
    fs.renameSync(extractDir, targetDir);
  } catch (error) {
    if (hadPrevious) fs.renameSync(backupDir, targetDir);
    throw toInstallFailed(error, meta.slug);
  }

  try {
    writeSkillMeta(targetDir, meta);
  } catch (error) {
    // Roll the deployment back — never leave content without metadata. The
    // metadata-less directory is parked inside staging so the caller's
    // guarded staging cleanup removes it; no in-place recursive delete here.
    try {
      fs.renameSync(targetDir, path.join(staging, `rollback-discard-${meta.slug}`));
      if (hadPrevious) fs.renameSync(backupDir, targetDir);
    } catch {
      // The original failure wins; a leftover directory is surfaced by the
      // next install's unmanaged-conflict check instead of an unguarded rm.
    }
    throw toInstallFailed(error, meta.slug);
  }
}

function toInstallFailed(error: unknown, slug: string): CliError {
  if (error instanceof CliError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new CliError({
    code: 'INSTALL_FAILED',
    message: `Failed to install skill '${slug}'.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
    detail: reason,
  });
}
