/**
 * SkillsPackService — orchestrates `skills pack-install`:
 *
 *   pack manifest fetch → per-member local-state precheck → user confirmation
 *   (skipped when every member is already installed) → whole-pack zip download
 *   with SHA256 verification (a single re-fetch on URL expiry, auth failure
 *   or checksum mismatch) → serial member installation via SkillsInstallService
 *   → summary.
 *
 * Terminal failures (PACK_NOT_FOUND, PACK_EMPTY, whole-pack download or
 * verification errors) throw immediately; member-level failures are recorded
 * per item and processing continues. The signed OSS URL never appears in any
 * result or error message.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import {
  toFullSlugString,
  PROVIDER_PATTERN,
  isValidBareSlug,
  isRealPathWithinBase,
} from '../utils/skills-security.js';
import { readZipEntryByPath } from '../utils/zip-reader.js';
import { safeRemove, skillStagingPrefix } from './skills-removal.js';
import { assessSkillDir, skillMetaFileName } from './skills-state-manager.js';
import type { SkillsHubService } from './skills-hub-service.js';
import type { SkillsInstallService } from './skills-install-service.js';
import type {
  PackDownload,
  PackInstallResult,
  PackInstallSummary,
  PackItemResult,
  PackManifest,
} from '../types/skills.js';

/**
 * Internal control-flow signal for a declined confirmation. Not part of the
 * error-code table — the command layer catches it and exits 0.
 */
export const USER_CANCELLED_CODE = 'USER_CANCELLED';

export interface PackOverrideMember {
  /** Bare skill name (directory name). */
  skillName: string;
  /** Full slug of the new skill to install. */
  fullSlug: string;
  /** Version of the new skill to install. */
  version: string;
  /** Full slug of the existing skill being replaced. */
  previousSlug: string;
  /** Version of the existing skill being replaced. */
  previousVersion: string;
}

export interface PackInstallPlan {
  install: number;
  change: number;
  noop: number;
  failed: number;
  /** Number of change members that override a different slug (slug conflict). */
  override: number;
  /** Detail of each slug-conflict override; empty when override === 0. */
  overrideMembers: PackOverrideMember[];
}

export interface PackInstallOptions {
  packName: string;
  baseDir: string;
  downloadTimeoutMs?: number;
  /** Confirmation callback — returning false cancels the install. */
  onConfirm?: (plan: PackInstallPlan) => Promise<boolean>;
  /** Progress callback — invoked once per processed member (noop included). */
  onProgress?: (item: PackItemResult, index: number, total: number) => void;
}

export interface SkillsPackDeps {
  /** Injectable fetch for tests; defaults to the global implementation. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

interface NormalizedMember {
  provider: string;
  skillName: string;
  version: string;
  fullSlug: string;
  targetDir: string;
}

type MemberPlan =
  | { kind: 'install'; member: NormalizedMember }
  | { kind: 'change'; member: NormalizedMember; previousVersion: string; previousSlug?: string }
  | { kind: 'noop'; member: NormalizedMember }
  | { kind: 'failed'; member: NormalizedMember; error: { code: string; message: string } };

/** Internal retryable signal: the signed pack URL was rejected with HTTP 403. */
class PackUrlAuthError extends Error {}

export class SkillsPackService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly hubService: SkillsHubService,
    private readonly installService: SkillsInstallService,
    deps: SkillsPackDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async installPack(options: PackInstallOptions): Promise<PackInstallResult> {
    const packName = options.packName;
    const baseDir = path.resolve(options.baseDir);

    const download = await this.hubService.getPackDownload(packName);
    const manifest = download.manifest;
    const { members, rejected } = normalizePackMembers(manifest, baseDir);
    if (members.length === 0 && rejected.length === 0) {
      throw packEmptyError(packName);
    }

    if (members.length === 0) {
      // All members were rejected during normalization — return each as a
      // failed item instead of throwing PACK_EMPTY (the pack is not empty,
      // its members failed validation).
      const rejectedItems: PackItemResult[] = rejected.map((r) => ({
        fullSlug: r.rawName,
        outcome: 'failed' as const,
        error: {
          code: 'INSTALL_FAILED',
          message: `Skill '${r.rawName}' has invalid manifest data and was skipped.`,
        },
      }));
      return summarize(packName, displayNameOf(manifest), baseDir, rejectedItems);
    }

    const plans = members.map((member) => precheckMember(member, baseDir));

    const rejectedItems: PackItemResult[] = rejected.map((r) => ({
      fullSlug: r.rawName,
      outcome: 'failed' as const,
      error: {
        code: 'INSTALL_FAILED',
        message: `Skill '${r.rawName}' has invalid manifest data and was skipped.`,
      },
    }));

    const total = plans.length + rejectedItems.length;

    // Every member already installed or precheck-failed: no confirmation, no download.
    if (plans.every((plan) => plan.kind === 'noop' || plan.kind === 'failed')) {
      const items = plans.map((plan, index) => {
        const base = memberItem(plan);
        const item: PackItemResult =
          plan.kind === 'failed' ? { ...base, outcome: 'failed', error: plan.error } : base;
        options.onProgress?.(item, index, total);
        return item;
      });
      for (let i = 0; i < rejectedItems.length; i++) {
        options.onProgress?.(rejectedItems[i], plans.length + i, total);
      }
      return summarize(packName, displayNameOf(manifest), baseDir, [...items, ...rejectedItems]);
    }

    if (options.onConfirm) {
      const overridePlans = plans.filter(
        (p): p is Extract<MemberPlan, { kind: 'change' }> =>
          p.kind === 'change' && !!p.previousSlug,
      );
      const plan: PackInstallPlan = {
        install: plans.filter((p) => p.kind === 'install').length,
        change: plans.filter((p) => p.kind === 'change').length,
        noop: plans.filter((p) => p.kind === 'noop').length,
        failed: plans.filter((p) => p.kind === 'failed').length + rejectedItems.length,
        override: overridePlans.length,
        overrideMembers: overridePlans.map((p) => ({
          skillName: p.member.skillName,
          fullSlug: p.member.fullSlug,
          version: p.member.version,
          previousSlug: p.previousSlug!,
          previousVersion: p.previousVersion,
        })),
      };
      const confirmed = await options.onConfirm(plan);
      if (!confirmed) {
        throw new CliError({
          code: USER_CANCELLED_CODE,
          message: 'Cancelled.',
          exitCode: EXIT_CODES.SUCCESS,
        });
      }
    }

    const staging = fs.mkdtempSync(path.join(baseDir, skillStagingPrefix()));
    try {
      const packZipBuffer = await this.downloadPackZip(
        packName,
        download,
        staging,
        baseDir,
        options.downloadTimeoutMs,
      );

      const items: PackItemResult[] = [];
      for (let index = 0; index < plans.length; index++) {
        const item = await this.installPlanMember(plans[index], packZipBuffer, baseDir);
        items.push(item);
        options.onProgress?.(item, index, total);
      }
      for (let i = 0; i < rejectedItems.length; i++) {
        options.onProgress?.(rejectedItems[i], plans.length + i, total);
      }
      return summarize(packName, displayNameOf(manifest), baseDir, [...items, ...rejectedItems]);
    } finally {
      safeRemove(staging, { baseDir, expectKind: 'staging' });
    }
  }

  private async installPlanMember(
    plan: MemberPlan,
    packZipBuffer: Buffer,
    baseDir: string,
  ): Promise<PackItemResult> {
    const member = plan.member;

    if (plan.kind === 'noop' || plan.kind === 'failed') {
      const item = memberItem(plan);
      return plan.kind === 'failed' ? { ...item, outcome: 'failed', error: plan.error } : item;
    }

    try {
      const memberZip = readZipEntryByPath(packZipBuffer, `skills/${member.skillName}.zip`);
      const isSlugOverride = plan.kind === 'change' && !!plan.previousSlug;
      const result = await this.installService.installMember({
        provider: member.provider,
        skillName: member.skillName,
        version: member.version,
        zipBuffer: memberZip,
        baseDir,
        ...(isSlugOverride ? { allowSlugOverwrite: true } : {}),
      });
      return {
        fullSlug: member.fullSlug,
        outcome: plan.kind === 'install' ? 'installed' : 'changed',
        version: member.version,
        ...(plan.kind === 'change' ? { previousVersion: plan.previousVersion } : {}),
        ...(isSlugOverride ? { previousSlug: plan.previousSlug } : {}),
        targetDir: result.targetDir,
      };
    } catch (error) {
      return {
        fullSlug: member.fullSlug,
        outcome: 'failed',
        version: member.version,
        error: toMemberError(error),
      };
    }
  }

  /**
   * Download and verify the whole-pack zip. A stale signed URL is refreshed
   * before the first attempt; an auth failure (HTTP 403) or a checksum
   * mismatch triggers exactly one re-fetch with a fresh URL before the
   * terminal error. The re-fetched URL is always used — the stale one is
   * never retried.
   */
  private async downloadPackZip(
    packName: string,
    initial: PackDownload,
    staging: string,
    baseDir: string,
    timeoutMs?: number,
  ): Promise<Buffer> {
    let download = initial;
    if (isExpiredAt(download.expiresAt)) {
      download = await this.hubService.getPackDownload(packName);
    }

    const expectedSha256 = (download.sha256 ?? '').trim().toLowerCase();
    if (!expectedSha256) {
      throw new CliError({
        code: 'INSTALL_FAILED',
        message: `Download verification failed for skill pack '${packName}': the server did not provide a SHA256 checksum.`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    const zipPath = path.join(staging, 'pack.zip');
    for (let attempt = 1; ; attempt++) {
      let zipBuffer: Buffer;
      try {
        zipBuffer = await this.downloadToBuffer(download.ossUrl, zipPath, baseDir, timeoutMs);
      } catch (error) {
        if (error instanceof PackUrlAuthError) {
          if (attempt === 1) {
            download = await this.hubService.getPackDownload(packName);
            continue;
          }
          // A re-fetched URL that still fails auth is terminal (T-4).
          throw new CliError({
            code: 'DOWNLOAD_FAILED',
            message: `Skill pack download failed (HTTP 403).`,
            exitCode: EXIT_CODES.GENERAL_ERROR,
          });
        }
        throw error;
      }
      if (sha256Matches(zipBuffer, download.sha256)) {
        return zipBuffer;
      }
      safeRemove(zipPath, { baseDir, expectKind: 'temp-file' });
      if (attempt === 1) {
        download = await this.hubService.getPackDownload(packName);
        continue;
      }
      throw new CliError({
        code: 'INSTALL_FAILED',
        message: `SHA256 mismatch for skill pack '${packName}'. Existing files were not changed.`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }
  }

  /** Stream the pack zip to a temp file and read it back; abort on timeout, clean up on failure. */
  private async downloadToBuffer(
    url: string,
    filePath: string,
    baseDir: string,
    timeoutMs?: number,
  ): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (response.status === 403) {
        throw new PackUrlAuthError();
      }
      if (!response.ok) {
        throw new CliError({
          code: 'DOWNLOAD_FAILED',
          message: `Skill pack download failed (HTTP ${response.status}).`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
      if (!response.body) {
        throw new CliError({
          code: 'DOWNLOAD_FAILED',
          message: 'Skill pack download failed: empty response body.',
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream),
        fs.createWriteStream(filePath),
      );
      return fs.readFileSync(filePath);
    } catch (error) {
      safeRemove(filePath, { baseDir, expectKind: 'temp-file' });
      if (error instanceof CliError || error instanceof PackUrlAuthError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new CliError({
        code: 'DOWNLOAD_FAILED',
        message: timedOut
          ? 'Skill pack download timed out.'
          : 'Skill pack download failed. Check your network and try again.',
        exitCode: EXIT_CODES.GENERAL_ERROR,
        detail: reason,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

interface RejectedMember {
  rawName: string;
}

interface NormalizePackResult {
  members: NormalizedMember[];
  rejected: RejectedMember[];
}

/**
 * Normalize manifest members. Entries are read with PascalCase/camelCase
 * tolerance; entries that are non-objects or carry no identifiable fields are
 * silently skipped. Entries whose provider or skillName fail validation are
 * collected in `rejected` so the caller can report them as failures.
 */
function normalizePackMembers(manifest: PackManifest, baseDir: string): NormalizePackResult {
  const record = manifest as unknown as Record<string, unknown>;
  const rawSkills = record.Skills ?? record.skills;
  if (!Array.isArray(rawSkills)) return { members: [], rejected: [] };
  const members: NormalizedMember[] = [];
  const rejected: RejectedMember[] = [];
  for (const raw of rawSkills) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const provider = toStr(item.Provider ?? item.provider);
    const skillName = toStr(item.SkillName ?? item.skillName);
    if (!provider && !skillName) continue;
    if (
      !provider ||
      !skillName ||
      !PROVIDER_PATTERN.test(provider) ||
      !isValidBareSlug(skillName)
    ) {
      rejected.push({ rawName: rejectedMemberName(provider, skillName) });
      continue;
    }
    const rawVersion = item.Version ?? item.version;
    const version = typeof rawVersion === 'string' && rawVersion !== '' ? rawVersion : undefined;
    if (version === undefined) {
      rejected.push({ rawName: rejectedMemberName(provider, skillName) });
      continue;
    }
    members.push({
      provider,
      skillName,
      version,
      fullSlug: toFullSlugString(provider, skillName),
      targetDir: path.join(baseDir, skillName),
    });
  }
  return { members, rejected };
}

/**
 * Classify one member against its local directory state: absent → install,
 * managed with a different version → change, managed with the same version →
 * noop, unmanaged → failed. A managed target with an unversioned manifest
 * entry cannot be compared — the local files are kept and the member is
 * recorded as failed.
 */
function precheckMember(member: NormalizedMember, baseDir: string): MemberPlan {
  if (!isRealPathWithinBase(baseDir, member.targetDir)) {
    return {
      kind: 'failed',
      member,
      error: {
        code: 'INSTALL_FAILED',
        message: 'target directory resolves outside the base directory',
      },
    };
  }
  const state = assessSkillDir(member.targetDir);
  if (state.kind === 'unmanaged') {
    return {
      kind: 'failed',
      member,
      error: {
        code: 'UNMANAGED_CONFLICT',
        message: `The directory '${member.targetDir}' already exists but is not managed by this CLI (${skillMetaFileName()} is missing or invalid). Please rename or remove the directory, then run the command again. No changes were made this time.`,
      },
    };
  }
  if (state.kind === 'managed') {
    // Slug identity check: a different skill occupies the same target dir.
    if (state.meta.slug !== member.fullSlug) {
      return {
        kind: 'change',
        member,
        previousVersion: state.meta.version,
        previousSlug: state.meta.slug,
      };
    }
    if (state.meta.version === member.version) {
      return { kind: 'noop', member };
    }
    return { kind: 'change', member, previousVersion: state.meta.version };
  }
  return { kind: 'install', member };
}

/** Result item for a member that needs no installation call (noop / precheck failure). */
function memberItem(plan: Extract<MemberPlan, { kind: 'noop' | 'failed' }>): PackItemResult {
  const member = plan.member;
  return {
    fullSlug: member.fullSlug,
    outcome: 'noop',
    version: member.version,
  };
}

/** Map an installMember failure onto the member-level error record. */
function toMemberError(error: unknown): { code: string; message: string } {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'INSTALL_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Pack display name with PascalCase tolerance; falls back to the pack name. */
function displayNameOf(manifest: PackManifest): string {
  const record = manifest as unknown as Record<string, unknown>;
  const displayName = toStr(record.DisplayName ?? record.displayName);
  return displayName || toStr(record.PackName ?? record.packName);
}

function summarize(
  packName: string,
  displayName: string,
  baseDir: string,
  items: PackItemResult[],
): PackInstallResult {
  const summary: PackInstallSummary = {
    installed: items.filter((i) => i.outcome === 'installed').length,
    changed: items.filter((i) => i.outcome === 'changed').length,
    skipped: items.filter((i) => i.outcome === 'noop').length,
    failed: items.filter((i) => i.outcome === 'failed').length,
  };
  const overallStatus =
    summary.failed === 0
      ? 'success'
      : summary.installed + summary.changed + summary.skipped > 0
        ? 'partial'
        : 'failed';
  return {
    pack: packName,
    displayName: displayName || packName,
    overallStatus,
    baseDir,
    summary,
    items,
  };
}

function isExpiredAt(expiresAt: string): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  return !Number.isNaN(ts) && ts <= Date.now();
}

function sha256Matches(zipBuffer: Buffer, expected: string): boolean {
  const normalized = expected.trim().toLowerCase();
  if (!normalized) return false;
  return createHash('sha256').update(zipBuffer).digest('hex') === normalized;
}

function packEmptyError(packName: string): CliError {
  return new CliError({
    code: 'PACK_EMPTY',
    message: `Skill pack is empty: ${packName}.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

function rejectedMemberName(provider: string, skillName: string): string {
  if (provider && skillName) return `${provider}/${skillName}`;
  return skillName || provider || '(unknown)';
}

function toStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
