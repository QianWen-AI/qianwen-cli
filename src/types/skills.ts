// SkillHub types (SearchHub / GetHubSkill / GetHubSkillDownload via the
// WebsitePortal gateway)

/**
 * Raw SearchHub item — the server responds with PascalCase field names, while
 * lowerCamelCase variants also occur; both spellings are tolerated
 * (PascalCase preferred, camelCase fallback).
 */
export interface RawSkillSearchItem {
  // PascalCase field names (preferred)
  ResourceType?: string | null;
  ResourceId?: string | null;
  ResourceName?: string | null;
  DisplayName?: string | null;
  Description?: string | null;
  Channel?: string | null;
  AuthorName?: string | null;
  SecurityDesc?: string | null;
  SecurityStatus?: string | null;
  CurrentVersion?: string | null;
  Status?: string | null;
  // camelCase field names (fallback)
  resourceType?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  displayName?: string | null;
  description?: string | null;
  channel?: string | null;
  authorName?: string | null;
  securityDesc?: string | null;
  securityStatus?: string | null;
  currentVersion?: string | null;
  status?: string | null;
}

/** Raw SearchHub business payload (`data.Data` in the actual response). */
export interface RawSearchHubData {
  TotalCount?: number | null;
  PageNo?: number | null;
  PageSize?: number | null;
  Items?: RawSkillSearchItem[] | null;
  totalCount?: number | null;
  pageNo?: number | null;
  pageSize?: number | null;
  items?: RawSkillSearchItem[] | null;
}

/**
 * Inner gateway envelope returned by `callFlatApi` for WebsitePortal actions.
 * The outer envelope (`code === '200'`) is unwrapped by the API layer; this
 * second business envelope must be unwrapped by the service layer.
 */
export interface RawHubEnvelope<TData> {
  RequestId?: string | null;
  Message?: string | null;
  Code?: string | null;
  Success?: boolean | null;
  Data?: TData | null;
  requestId?: string | null;
  message?: string | null;
  code?: string | null;
  success?: boolean | null;
  data?: TData | null;
}

export type RawSearchHubEnvelope = RawHubEnvelope<RawSearchHubData>;

/**
 * Normalized skill search item — the CLI output field mapping:
 *   ResourceName→slug, DisplayName??ResourceName→name, Description→description,
 *   AuthorName→publisher, CurrentVersion→currentVersion (omit key when absent),
 *   verified = isVerifiedSecurityStatus(securityStatus) (machine enum, locale
 *   independent).
 */
export interface SkillSearchItem {
  slug: string;
  name: string;
  description: string;
  publisher: string;
  /** Omitted (not null) when the server response lacks CurrentVersion. */
  currentVersion?: string;
  verified: boolean;
}

export interface SkillsSearchResult {
  query: string;
  totalCount: number;
  results: SkillSearchItem[];
}

// ── GetHubSkill (skill detail) ──────────────────────────────────────────────

/** Raw version history entry; both field spellings are tolerated. */
export interface RawSkillVersionItem {
  Version?: string | null;
  PublishedAt?: string | null;
  Changelog?: string | null;
  IsLatest?: boolean | null;
  version?: string | null;
  publishedAt?: string | null;
  changelog?: string | null;
  isLatest?: boolean | null;
}

/** Raw security block — `{ AuditStatus, AuditTime }` (per-version audit info). */
export interface RawSkillSecurity {
  AuditStatus?: string | null;
  AuditTime?: string | null;
  auditStatus?: string | null;
  auditTime?: string | null;
}

/** Raw GetHubSkill business payload (`data.Data`); unknown fields tolerated. */
export interface RawSkillDetailData {
  SkillId?: string | null;
  SkillName?: string | null;
  DisplayName?: string | null;
  Description?: string | null;
  Overview?: string | null;
  Channel?: string | null;
  SecurityStatus?: string | null;
  Security?: RawSkillSecurity | null;
  Versions?: RawSkillVersionItem[] | null;
  skillId?: string | null;
  skillName?: string | null;
  displayName?: string | null;
  description?: string | null;
  overview?: string | null;
  channel?: string | null;
  securityStatus?: string | null;
  security?: RawSkillSecurity | null;
  versions?: RawSkillVersionItem[] | null;
}

export type RawSkillDetailEnvelope = RawHubEnvelope<RawSkillDetailData>;

export interface SkillVersionInfo {
  version: string;
  publishedAt: string;
  changelog: string;
  isLatest: boolean;
}

/** Normalized GetHubSkill result — only the fields install consumes. */
export interface SkillDetail {
  slug: string;
  displayName: string;
  description: string;
  /** Top-level machine security state (`safe` / `risk`); empty when absent. */
  securityStatus: string;
  /** Raw `Security.AuditStatus` value (current online version audit). */
  auditStatus: string;
  auditTime: string;
  /** Version marked `isLatest`; empty string when none is available. */
  latestVersion: string;
  versions: SkillVersionInfo[];
}

// ── GetHubSkillDownload ─────────────────────────────────────────────────────

/** Raw GetHubSkillDownload business payload (`data.Data`). */
export interface RawSkillDownloadData {
  OssUrl?: string | null;
  ExpiresAt?: string | null;
  Sha256?: string | null;
  ossUrl?: string | null;
  expiresAt?: string | null;
  sha256?: string | null;
}

export type RawSkillDownloadEnvelope = RawHubEnvelope<RawSkillDownloadData>;

/** Normalized download descriptor: signed temporary OSS URL + expiry. */
export interface SkillDownload {
  ossUrl: string;
  expiresAt: string;
  /** Server-declared package SHA256; omitted when the server does not return it. */
  sha256?: string;
}

// ── Install metadata & result ───────────────────────────────────────────────

/** On-disk skill metadata, schema v1. Unknown extra fields are tolerated on read. */
export interface SkillMetadataV1 {
  schemaVersion: 1;
  slug: string;
  version: string;
  /** SHA256 of the downloaded zip, computed locally after download. */
  sha256: string;
  installMethod: 'copy';
  installedAt: string;
  clientVersion: string;
}

export type SkillUnmanagedReason =
  | 'missing-metadata'
  | 'metadata-parse-failed'
  | 'schema-version-too-new'
  | 'missing-required-fields';

/**
 * Classification of an install target directory:
 * absent (fresh install), managed (valid metadata) or unmanaged (directory
 * exists but metadata is missing/broken — install refuses to touch it).
 */
export type SkillDirState =
  | { kind: 'absent' }
  | { kind: 'managed'; meta: SkillMetadataV1 }
  | { kind: 'unmanaged'; reason: SkillUnmanagedReason };

export type SkillInstallOutcome = 'installed' | 'updated' | 'noop';

export interface SkillsInstallResult {
  slug: string;
  version: string;
  outcome: SkillInstallOutcome;
  targetDir: string;
  /** Raw platform security state (e.g. `safe`); empty string when absent. */
  securityStatus: string;
  /** Locale-derived display label for the security state. */
  securityLabel: string;
  /** Zip SHA256; for a noop this echoes the recorded value from metadata. */
  sha256: string;
  /**
   * Present only when an update actually replaced a locally newer version
   * (both versions semver-parsable and installed > hub latest).
   */
  downgrade?: { from: string; to: string };
}
