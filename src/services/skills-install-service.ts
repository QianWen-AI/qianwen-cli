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
import {
  parseFullSlug,
  toFullSlugString,
  resolveWithinBase,
  isRealPathWithinBase,
  type FullSlug,
} from '../utils/skills-security.js';
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
  /** Full slug (`@ns/name`) or bare slug; parsed to select the install path. */
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
  /** Pre-parsed full slug; takes precedence over re-parsing `options.slug`. */
  parsedSlug?: FullSlug | null;
  /**
   * When true, allows overwriting a managed directory that belongs to a
   * different skill (slug conflict). Without this flag the service throws
   * a `SLUG_CONFLICT` error.
   */
  allowSlugOverwrite?: boolean;
}

export interface SkillsInstallDeps {
  /** Injectable fetch for tests; defaults to the global implementation. */
  fetchImpl?: typeof fetch;
}

export interface SkillMemberInstallOptions {
  /** Provider ID with the leading `@` (e.g. `@qianwen-ai`). */
  provider: string;
  /** Bare skill name. */
  skillName: string;
  /** Version to record in the skill metadata. */
  version: string;
  /** Member zip payload (extracted from the outer pack zip). */
  zipBuffer: Buffer;
  /** Base directory that will contain `<baseDir>/<skillName>/`. */
  baseDir: string;
  /** When true, allows overwriting a managed directory belonging to a different slug. */
  allowSlugOverwrite?: boolean;
}

export interface SkillMemberInstallResult {
  targetDir: string;
  /** SHA256 of the member zip payload. */
  sha256: string;
}

export interface SlugConflictInfo {
  /** Slug currently recorded in the target directory metadata. */
  existingSlug: string;
  /** Version currently recorded in the target directory metadata. */
  existingVersion: string;
  /** Absolute path of the conflicting target directory. */
  targetDir: string;
}

/**
 * Determine whether two slugs refer to the same skill. Handles the
 * bare↔full slug migration: a bare slug (`my-skill`) and its canonical
 * full form (`@provider/my-skill`) are treated as equivalent. When both
 * slugs carry a provider, both provider and skill name must match.
 */
function isSameSkill(slugA: string, slugB: string): boolean {
  const parsedA = parseFullSlug(slugA);
  const parsedB = parseFullSlug(slugB);
  const nameA = parsedA?.skillName ?? slugA;
  const nameB = parsedB?.skillName ?? slugB;
  if (nameA !== nameB) return false;
  // When both are full slugs, providers must also match.
  if (parsedA && parsedB) return parsedA.provider === parsedB.provider;
  // One is bare, one is full (or both bare) — same skill name suffices.
  return true;
}

export class SkillsInstallService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly hubService: SkillsHubService,
    deps: SkillsInstallDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /**
   * Pre-flight check: detect whether installing `slug` into `baseDir` would
   * overwrite a managed directory belonging to a different skill.
   *
   * Returns conflict info when a slug mismatch exists; `null` otherwise.
   */
  precheckSlugConflict(
    slug: string,
    baseDir: string,
    serverProvider?: string,
  ): SlugConflictInfo | null {
    const resolvedBase = path.resolve(baseDir);
    const parsed = parseFullSlug(slug);
    const skillName = parsed ? parsed.skillName : slug;
    // Canonicalize: prefer user-provided provider, then server provider.
    const provider = parsed?.provider || serverProvider || undefined;
    const resultSlug = provider ? toFullSlugString(provider, skillName) : slug;
    const targetDir = parsed
      ? path.join(resolvedBase, parsed.skillName)
      : path.join(resolvedBase, slug);
    const state = assessSkillDir(targetDir);
    if (
      state.kind === 'managed' &&
      state.meta.slug !== resultSlug &&
      !isSameSkill(state.meta.slug, resultSlug)
    ) {
      return {
        existingSlug: state.meta.slug,
        existingVersion: state.meta.version,
        targetDir,
      };
    }
    return null;
  }

  async install(options: SkillsInstallOptions): Promise<SkillsInstallResult> {
    const { slug } = options;
    const baseDir = path.resolve(options.baseDir);
    assertBaseDir(baseDir);

    // Full slugs install two levels deep (@ns/slug) and pass the provider to
    // the hub; bare slugs keep the legacy single-level, provider-less path.
    const parsed = options.parsedSlug ?? parseFullSlug(slug);
    const skillName = parsed ? parsed.skillName : slug;
    const parsedProvider = parsed?.provider;

    const detail =
      options.preloadedDetail ?? (await this.hubService.getSkillDetail(skillName, parsedProvider));

    // Canonicalize: if server provides provider and we have a bare slug, upgrade to full slug.
    const provider = parsedProvider || detail.provider || undefined;
    const resultSlug = provider ? toFullSlugString(provider, skillName) : slug;
    const securityLabel = securityStatusLabel(detail.securityStatus);
    const version = detail.latestVersion;
    if (!version) {
      throw new CliError({
        code: 'INSTALL_FAILED',
        message: `No published version available for skill '${resultSlug}'.`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    const targetDir = parsed ? path.join(baseDir, parsed.skillName) : path.join(baseDir, slug);

    const state = assessSkillDir(targetDir);
    if (state.kind === 'unmanaged') {
      throw unmanagedConflictError(resultSlug, targetDir, state);
    }

    // Slug-conflict detection: the target directory is managed but belongs
    // to a different skill. The caller must opt in via allowSlugOverwrite.
    // Bare↔full slug equivalence: if both slugs resolve to the same skill
    // name, skip the conflict path and let the upgrade path handle it.
    if (
      state.kind === 'managed' &&
      state.meta.slug !== resultSlug &&
      !isSameSkill(state.meta.slug, resultSlug)
    ) {
      if (!options.allowSlugOverwrite) {
        throw new CliError({
          code: 'SLUG_CONFLICT',
          message:
            `Target directory is occupied by a different skill ` +
            `(${state.meta.slug} ${state.meta.version}). ` +
            `Use --dir to explicitly override, or run in an interactive terminal.`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
      // Forced overwrite: treat as a fresh install so the previous content
      // is replaced entirely.
      const slugOverwriteInfo = {
        overwritten: true as const,
        previousSlug: state.meta.slug,
        previousVersion: state.meta.version,
      };

      const overwriteDetail =
        options.preloadedDetail ??
        (await this.hubService.getSkillDetail(skillName, parsedProvider));
      // Re-canonicalize with the overwrite-path detail.
      const owProvider = parsedProvider || overwriteDetail.provider || undefined;
      const owResultSlug = owProvider ? toFullSlugString(owProvider, skillName) : slug;
      const secLabel = securityStatusLabel(overwriteDetail.securityStatus);
      const ver = overwriteDetail.latestVersion;
      if (!ver) {
        throw new CliError({
          code: 'INSTALL_FAILED',
          message: `No published version available for skill '${owResultSlug}'.`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }

      const download = await this.hubService.getSkillDownload(skillName, ver, owProvider);
      const staging = fs.mkdtempSync(path.join(baseDir, skillStagingPrefix()));
      let preserveStaging = false;
      try {
        const zipPath = path.join(staging, 'skill.zip');
        await this.downloadToFile(download.ossUrl, zipPath, baseDir, options.downloadTimeoutMs);
        const zipBuffer = fs.readFileSync(zipPath);
        const sha256 = createHash('sha256').update(zipBuffer).digest('hex');
        const expectedSha256 = (download.sha256 ?? '').trim().toLowerCase();
        if (!expectedSha256) {
          safeRemove(zipPath, { baseDir, expectKind: 'temp-file' });
          throw new CliError({
            code: 'INSTALL_FAILED',
            message: `Download verification failed for '${owResultSlug}': the server did not provide a SHA256 checksum.`,
            exitCode: EXIT_CODES.GENERAL_ERROR,
          });
        }
        if (expectedSha256 !== sha256.trim().toLowerCase()) {
          safeRemove(zipPath, { baseDir, expectKind: 'temp-file' });
          throw new CliError({
            code: 'INSTALL_FAILED',
            message: `SHA256 mismatch for '${owResultSlug}': expected ${expectedSha256}, got ${sha256}. Existing files were not changed.`,
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
              message: `Refusing to install '${owResultSlug}': ${error.message}`,
              exitCode: EXIT_CODES.GENERAL_ERROR,
            });
          }
          throw error;
        }
        if (!fs.existsSync(path.join(extractDir, 'SKILL.md'))) {
          throw new CliError({
            code: 'INSTALL_FAILED',
            message: `Invalid Skill package for '${owResultSlug}': SKILL.md was not found.`,
            exitCode: EXIT_CODES.GENERAL_ERROR,
          });
        }
        deployAndWriteMeta(
          baseDir,
          extractDir,
          targetDir,
          staging,
          {
            schemaVersion: 1,
            slug: owResultSlug,
            ...(owProvider ? { provider: owProvider } : {}),
            version: ver,
            sha256,
            installMethod: 'copy',
            installedAt: new Date().toISOString(),
            clientVersion: CLIENT_VERSION,
          },
          () => {
            preserveStaging = true;
          },
        );
        return {
          slug: owResultSlug,
          version: ver,
          outcome: 'installed' as const,
          targetDir,
          securityStatus: overwriteDetail.securityStatus,
          securityLabel: secLabel,
          sha256,
          ...(overwriteDetail.requiresApiKey === true ? { requiresApiKey: true } : {}),
          ...slugOverwriteInfo,
        };
      } finally {
        if (!preserveStaging) {
          safeRemove(staging, { baseDir, expectKind: 'staging' });
        }
      }
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
      const recorded = state.kind === 'managed' ? state.meta.sha256 : '';
      return {
        slug: resultSlug,
        version,
        outcome,
        targetDir,
        securityStatus: detail.securityStatus,
        securityLabel,
        sha256: recorded,
        ...(detail.requiresApiKey === true ? { requiresApiKey: true } : {}),
      };
    }

    const download = await this.hubService.getSkillDownload(skillName, version, provider);

    // Staging lives next to the target so the final rename stays on one
    // filesystem (atomic); the prefix is brand-derived and dot-hidden.
    const staging = fs.mkdtempSync(path.join(baseDir, skillStagingPrefix()));
    let preserveStaging = false;
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
          message: `Download verification failed for '${resultSlug}': the server did not provide a SHA256 checksum.`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
      if (expectedSha256 !== sha256.trim().toLowerCase()) {
        safeRemove(zipPath, { baseDir, expectKind: 'temp-file' });
        throw new CliError({
          code: 'INSTALL_FAILED',
          message: `SHA256 mismatch for '${resultSlug}': expected ${expectedSha256}, got ${sha256}. Existing files were not changed.`,
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
            message: `Refusing to install '${resultSlug}': ${error.message}`,
            exitCode: EXIT_CODES.GENERAL_ERROR,
          });
        }
        throw error;
      }

      if (!fs.existsSync(path.join(extractDir, 'SKILL.md'))) {
        throw new CliError({
          code: 'INSTALL_FAILED',
          message: `Invalid Skill package for '${resultSlug}': SKILL.md was not found.`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }

      deployAndWriteMeta(
        baseDir,
        extractDir,
        targetDir,
        staging,
        {
          schemaVersion: 1,
          slug: resultSlug,
          ...(provider ? { provider } : {}),
          version,
          sha256,
          installMethod: 'copy',
          installedAt: new Date().toISOString(),
          clientVersion: CLIENT_VERSION,
        },
        () => {
          preserveStaging = true;
        },
      );

      return {
        slug: resultSlug,
        version,
        outcome,
        targetDir,
        securityStatus: detail.securityStatus,
        securityLabel,
        sha256,
        ...(downgrade ? { downgrade } : {}),
        ...(detail.requiresApiKey === true ? { requiresApiKey: true } : {}),
      };
    } finally {
      if (!preserveStaging) {
        safeRemove(staging, { baseDir, expectKind: 'staging' });
      }
    }
  }

  /**
   * Install a single pack member from an in-memory zip payload. Pack
   * orchestration (precheck, confirmation, outcome classification) lives in
   * SkillsPackService; this entry point only executes the extraction,
   * deployment and metadata write. The payload must contain a SKILL.md.
   */
  async installMember(options: SkillMemberInstallOptions): Promise<SkillMemberInstallResult> {
    const baseDir = path.resolve(options.baseDir);
    assertBaseDir(baseDir);
    const fullSlug = toFullSlugString(options.provider, options.skillName);
    const targetDir = path.join(baseDir, options.skillName);

    if (!resolveWithinBase(baseDir, options.skillName)) {
      throw new CliError({
        code: 'INSTALL_FAILED',
        message: `Refusing to install '${fullSlug}': target directory resolves outside the base directory.`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    const state = assessSkillDir(targetDir);
    if (state.kind === 'unmanaged') {
      throw unmanagedConflictError(fullSlug, targetDir, state);
    }

    // Slug-conflict detection for pack members.
    // Bare↔full slug equivalence applies here as well.
    if (
      state.kind === 'managed' &&
      state.meta.slug !== fullSlug &&
      !isSameSkill(state.meta.slug, fullSlug)
    ) {
      if (!options.allowSlugOverwrite) {
        throw new CliError({
          code: 'SLUG_CONFLICT',
          message:
            `Target directory is occupied by a different skill ` +
            `(${state.meta.slug} ${state.meta.version}).`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
    }

    const sha256 = createHash('sha256').update(options.zipBuffer).digest('hex');
    const staging = fs.mkdtempSync(path.join(baseDir, skillStagingPrefix()));
    let preserveStaging = false;
    try {
      const extractDir = path.join(staging, 'content');
      fs.mkdirSync(extractDir);
      try {
        extractZipTo(options.zipBuffer, extractDir);
      } catch (error) {
        if (error instanceof ZipReadError) {
          throw new CliError({
            code: 'INSTALL_FAILED',
            message: `Refusing to install '${fullSlug}': ${error.message}`,
            exitCode: EXIT_CODES.GENERAL_ERROR,
          });
        }
        throw error;
      }

      if (!fs.existsSync(path.join(extractDir, 'SKILL.md'))) {
        throw new CliError({
          code: 'INSTALL_FAILED',
          message: `Invalid Skill package for '${fullSlug}': SKILL.md was not found.`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }

      deployAndWriteMeta(
        baseDir,
        extractDir,
        targetDir,
        staging,
        {
          schemaVersion: 1,
          slug: fullSlug,
          provider: options.provider,
          version: options.version,
          sha256,
          installMethod: 'copy',
          installedAt: new Date().toISOString(),
          clientVersion: CLIENT_VERSION,
        },
        () => {
          preserveStaging = true;
        },
      );

      return { targetDir, sha256 };
    } finally {
      if (!preserveStaging) {
        safeRemove(staging, { baseDir, expectKind: 'staging' });
      }
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
      : `The directory '${targetDir}' already exists but is not managed by this CLI ` +
        `(${skillMetaFileName()} is missing or invalid). ` +
        `Please rename or remove the directory, then run the command again.`;
  return new CliError({
    code: 'UNMANAGED_CONFLICT',
    message: `${base} No changes were made this time.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

/**
 * Atomically deploy the extracted content over the target and write metadata
 * last. For an update the previous directory is parked inside the staging
 * area and restored if the swap or the metadata write fails.
 */
function deployAndWriteMeta(
  baseDir: string,
  extractDir: string,
  targetDir: string,
  staging: string,
  meta: SkillMetadataV1,
  onRollbackFailed?: () => void,
): void {
  const backupDir = path.join(staging, 'previous');
  const hadPrevious = fs.existsSync(targetDir);

  // TOCTOU guard: if a directory appeared after the initial check,
  // verify it is CLI-managed before treating it as a previous version.
  if (hadPrevious) {
    const currentState = assessSkillDir(targetDir);
    if (currentState.kind !== 'managed') {
      throw new CliError({
        code: 'UNMANAGED_CONFLICT',
        message:
          `A directory appeared at '${targetDir}' during installation ` +
          `but is not managed by this CLI. No changes were made.`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }
  }

  if (hadPrevious) {
    fs.renameSync(targetDir, backupDir);
  }
  if (!isRealPathWithinBase(baseDir, targetDir)) {
    if (hadPrevious) fs.renameSync(backupDir, targetDir);
    throw new CliError({
      code: 'INSTALL_FAILED',
      message: `Refusing to install '${meta.slug}': target directory resolves outside the base directory.`,
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });
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
    let rollbackFailed = false;
    try {
      fs.renameSync(targetDir, path.join(staging, 'rollback-discard'));
      if (hadPrevious) fs.renameSync(backupDir, targetDir);
    } catch {
      rollbackFailed = true;
    }
    if (rollbackFailed) {
      onRollbackFailed?.();
      throw new CliError({
        code: 'INSTALL_FAILED',
        message: `Unexpected error while installing '${meta.slug}'. The previous version is preserved in ${staging}.`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    throw toInstallFailed(error, meta.slug);
  }
}

function toInstallFailed(error: unknown, slug: string): CliError {
  if (error instanceof CliError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new CliError({
    code: 'INSTALL_FAILED',
    message: `Failed to install skill '${slug}'. Existing files were not changed.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
    detail: reason,
  });
}
