/**
 * SkillsHubService — SkillHub access via the WebsitePortal flat-parameter
 * gateway (SearchHub / GetHubSkill / GetHubSkillDownload plus the skill
 * collection list/detail/download actions).
 *
 * The API layer unwraps the outer gateway envelope (`code === '200'`); the
 * response then carries a second business envelope which this service unwraps:
 * success when `Success === true` or `Code === '200'`, business data under
 * `Data`. Field names are PascalCase with camelCase tolerated. All actions
 * share this envelope shape.
 */

import type { ApiClient } from '../api/api-client.js';
import { GatewayBusinessError } from '../api/request-adapter.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import {
  API_PRODUCT_WEBSITE_PORTAL,
  API_ACTION_SEARCH_HUB,
  API_ACTION_GET_HUB_SKILL,
  API_ACTION_GET_HUB_SKILL_DOWNLOAD,
  API_ACTION_HUB_COLLECTION_DOWNLOAD,
} from '../types/api-routes.js';
import type {
  RawHubEnvelope,
  RawSearchHubData,
  RawSkillDetailData,
  RawSkillDownloadData,
  RawSkillSearchItem,
  RawSkillVersionItem,
  RawPackDownloadData,
  SkillDetail,
  SkillDownload,
  SkillSearchItem,
  SkillVersionInfo,
  SkillsSearchResult,
  PackDownload,
  PackManifest,
} from '../types/skills.js';
import { site } from '../site.js';

export interface SkillsSearchOptions {
  /** Keyword query; empty string is accepted and passed through verbatim. */
  query: string;
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

/**
 * `verified` derives from the machine security-state enum `securityStatus`
 * (`safe` / `risk`), which is locale independent — unlike the display-only
 * `securityDesc` wording. Comparison is case-normalized for robustness.
 */
export function isVerifiedSecurityStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.toLowerCase() === 'safe';
}

/**
 * Machine security state → display labels per locale. The platform reports
 * `securityStatus` as a locale-independent enum (`safe` / `risk`); the CLI
 * derives the display wording from the site locale and falls back to the raw
 * value for unknown states — unknown values never block an install.
 */
const SECURITY_STATUS_LABELS_BY_LOCALE: Record<string, Record<string, string>> = {
  'zh-CN': { safe: '安全', risk: '不安全' },
  'en-US': { safe: 'safe', risk: 'risk' },
};

/** Display label for a platform security state; raw value / 'unknown' fallback. */
export function securityStatusLabel(status: string | null | undefined): string {
  const labels = SECURITY_STATUS_LABELS_BY_LOCALE[site.defaults.language] ?? {};
  const normalized = (status ?? '').toLowerCase();
  return labels[normalized] ?? (status || 'unknown');
}

export class SkillsHubService {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * Search SkillHub for skills. Auth is optional: a token
   * is attached when logged in, but anonymous calls succeed as well.
   */
  async searchSkills(options: SkillsSearchOptions): Promise<SkillsSearchResult> {
    const query = options.query ?? '';
    const limit = clampLimit(options.limit);

    const envelope = await this.apiClient.callFlatApi<RawHubEnvelope<RawSearchHubData> | null>({
      product: API_PRODUCT_WEBSITE_PORTAL,
      action: API_ACTION_SEARCH_HUB,
      params: {
        Query: query,
        ResourceTypes: ['skill'],
        PageNo: 1,
        PageSize: limit,
      },
      authOptional: true,
    });

    const data = unwrapHubEnvelope(envelope, 'SearchHub');
    const rawItems = extractItems(data);
    const results = hoistExactSlug(rawItems.map(normalizeSkillSearchItem), query).slice(0, limit);
    const totalCount = data?.TotalCount ?? data?.totalCount ?? results.length;

    return { query, totalCount, results };
  }

  /**
   * Fetch skill detail (GetHubSkill). Used by install for the latest version
   * number and the platform security state. A missing skill surfaces
   * as a SKILL_NOT_FOUND CliError with an actionable message.
   */
  async getSkillDetail(slug: string, provider?: string): Promise<SkillDetail> {
    const envelope = await this.apiClient.callFlatApi<RawHubEnvelope<RawSkillDetailData> | null>({
      product: API_PRODUCT_WEBSITE_PORTAL,
      action: API_ACTION_GET_HUB_SKILL,
      params: {
        SkillName: slug,
        Language: site.defaults.language,
        ...(provider ? { Provider: provider } : {}),
      },
      authOptional: true,
    });

    const displaySlug = provider ? `${provider}/${slug}` : slug;
    const data = unwrapHubEnvelope(envelope, 'GetHubSkill', displaySlug);
    return normalizeSkillDetail(slug, data);
  }

  /**
   * Fetch the signed temporary download URL (GetHubSkillDownload). When
   * `version` is omitted the server resolves the current published version.
   * `provider` is only sent for full-slug installs; the bare-slug mode omits it.
   */
  async getSkillDownload(
    slug: string,
    version?: string,
    provider?: string,
  ): Promise<SkillDownload> {
    const envelope = await this.apiClient.callFlatApi<RawHubEnvelope<RawSkillDownloadData> | null>({
      product: API_PRODUCT_WEBSITE_PORTAL,
      action: API_ACTION_GET_HUB_SKILL_DOWNLOAD,
      params: {
        SkillName: slug,
        ...(provider ? { Provider: provider } : {}),
        ...(version ? { SkillVersion: version } : {}),
      },
      authOptional: true,
    });

    const displaySlug = provider ? `${provider}/${slug}` : slug;
    const data = unwrapHubEnvelope(envelope, 'GetHubSkillDownload', displaySlug);
    const ossUrl = toStr(data?.OssUrl ?? data?.ossUrl);
    if (!ossUrl) {
      throw new GatewayBusinessError(
        'EMPTY_RESPONSE',
        'GetHubSkillDownload returned no download URL',
      );
    }
    const sha256 = toStr(data?.Sha256 ?? data?.sha256);
    return {
      ossUrl,
      expiresAt: toStr(data?.ExpiresAt ?? data?.expiresAt),
      ...(sha256 ? { sha256 } : {}),
    };
  }

  /**
   * Fetch the signed temporary pack download URL plus the pre-parsed
   * manifest. The wire `Manifest` is a JSON string (a pre-parsed object is
   * tolerated); parsing and validation are centralized here. A missing
   * pack surfaces as PACK_NOT_FOUND; an empty or malformed manifest as
   * PACK_EMPTY.
   */
  async getPackDownload(collectionName: string): Promise<PackDownload> {
    const envelope = await this.apiClient.callFlatApi<RawHubEnvelope<RawPackDownloadData> | null>({
      product: API_PRODUCT_WEBSITE_PORTAL,
      action: API_ACTION_HUB_COLLECTION_DOWNLOAD,
      params: {
        CollectionName: collectionName,
      },
      authOptional: true,
    });

    const data = unwrapHubEnvelope(envelope, 'HubSkillCollectionDownload', collectionName, 'pack');
    const ossUrl = toStr(data?.OssUrl ?? data?.ossUrl);
    if (!ossUrl) {
      throw new GatewayBusinessError(
        'EMPTY_RESPONSE',
        'HubSkillCollectionDownload returned no download URL',
      );
    }
    const manifest = parsePackManifest(collectionName, data?.Manifest ?? data?.manifest);
    return {
      ossUrl,
      sha256: toStr(data?.Sha256 ?? data?.sha256),
      expiresAt: toStr(data?.ExpiresAt ?? data?.expiresAt),
      manifest,
    };
  }
}

/** Service-level defensive clamp; strict user-input validation (exit 2) lives in the command layer. */
function clampLimit(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw as number) < MIN_LIMIT) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(raw as number));
}

/**
 * Unwrap the inner business envelope shared by all WebsitePortal SkillHub
 * actions; throws on business failure. A NOT_FOUND business code becomes an
 * actionable CliError: skill actions map to SKILL_NOT_FOUND (exit 1) and
 * pack actions map to PACK_NOT_FOUND (exit 1). "Resource does not exist"
 * is a deterministic result, not a transient network failure.
 */
function unwrapHubEnvelope<TData>(
  envelope: RawHubEnvelope<TData> | null,
  action: string,
  slug?: string,
  kind: 'skill' | 'pack' = 'skill',
): TData | null {
  if (!envelope || typeof envelope !== 'object') {
    throw new GatewayBusinessError('EMPTY_RESPONSE', `${action} returned an empty response`);
  }
  const success = envelope.Success ?? envelope.success;
  const code = envelope.Code ?? envelope.code;
  if (success !== true && String(code) !== '200') {
    if (String(code) === 'NOT_FOUND' && slug) {
      if (kind === 'pack') {
        throw new CliError({
          code: 'PACK_NOT_FOUND',
          message: `Skill pack not found: ${slug}.`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        });
      }
      throw new CliError({
        code: 'SKILL_NOT_FOUND',
        message: `Skill not found: ${slug}. Use \`skills search <keyword>\` to find available skills.`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }
    const message = envelope.Message ?? envelope.message ?? `${action} request failed`;
    throw new GatewayBusinessError(String(code ?? 'UNKNOWN'), String(message));
  }
  return envelope.Data ?? envelope.data ?? null;
}

/**
 * Parse and validate the pack manifest. The wire form is a JSON string (a
 * pre-parsed object is tolerated); anything unparseable or without a
 * non-empty skills list surfaces as PACK_EMPTY.
 */
function parsePackManifest(
  packName: string,
  raw: string | PackManifest | null | undefined,
): PackManifest {
  let manifest: unknown = raw;
  if (typeof raw === 'string') {
    try {
      manifest = JSON.parse(raw);
    } catch {
      throw packEmptyError(packName);
    }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw packEmptyError(packName);
  }
  const record = manifest as Record<string, unknown>;
  const skills = record.Skills ?? record.skills;
  if (!Array.isArray(skills) || skills.length === 0) {
    throw packEmptyError(packName);
  }
  return manifest as PackManifest;
}

function packEmptyError(packName: string): CliError {
  return new CliError({
    code: 'PACK_EMPTY',
    message: `Skill pack is empty: ${packName}.`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

function extractItems(data: RawSearchHubData | null): RawSkillSearchItem[] {
  const items = data?.Items ?? data?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * Normalize a raw item into the CLI output mapping. `slug` is the full slug
 * `@provider/skillName` when a provider id is known; `publisher` derives from
 * Provider.ProviderName with ProviderId as fallback (AuthorName is never
 * read). Keys are omitted (never null) when the server response lacks them;
 * an explicit `RequiresApiKey: false` is kept.
 */
function normalizeSkillSearchItem(raw: RawSkillSearchItem): SkillSearchItem {
  const providerObj = raw.Provider ?? raw.provider;
  const providerName = toStr(providerObj?.ProviderName ?? providerObj?.providerName);
  const providerId = toStr(providerObj?.ProviderId ?? providerObj?.providerId);
  const resourceName = toStr(raw.ResourceName ?? raw.resourceName);
  const displayName = toStr(raw.DisplayName ?? raw.displayName);
  const securityStatus = raw.SecurityStatus ?? raw.securityStatus;
  const currentVersion = toStr(raw.CurrentVersion ?? raw.currentVersion);
  const requiresApiKey = raw.RequiresApiKey ?? raw.requiresApiKey;
  return {
    slug: providerId ? `${providerId}/${resourceName}` : resourceName,
    name: displayName || resourceName,
    description: toStr(raw.Description ?? raw.description),
    publisher: providerName || providerId,
    ...(currentVersion ? { currentVersion } : {}),
    ...(typeof requiresApiKey === 'boolean' ? { requiresApiKey } : {}),
    verified: isVerifiedSecurityStatus(securityStatus),
  };
}

/**
 * Exact-slug hoist: when the query equals a result slug
 * exactly (case-sensitive), that result moves to the front; with multiple
 * matches only the first is hoisted. Relative order of the rest is preserved.
 */
function hoistExactSlug(items: SkillSearchItem[], query: string): SkillSearchItem[] {
  const idx = items.findIndex((item) => item.slug === query);
  if (idx <= 0) return items;
  return [items[idx], ...items.slice(0, idx), ...items.slice(idx + 1)];
}

/**
 * Normalize a raw GetHubSkill payload. The latest version is the entry
 * flagged `isLatest`, falling back to the first entry (server orders the
 * history newest-first).
 */
function normalizeSkillDetail(slug: string, data: RawSkillDetailData | null): SkillDetail {
  const security = data?.Security ?? data?.security;
  const versions = normalizeVersions(data?.Versions ?? data?.versions);
  const latest = versions.find((v) => v.isLatest) ?? versions[0];
  const requiresApiKey = data?.RequiresApiKey ?? data?.requiresApiKey;
  const providerBlock = data?.Provider ?? data?.provider;
  const provider = toStr(providerBlock?.ProviderId ?? providerBlock?.providerId);
  return {
    slug: toStr(data?.SkillName ?? data?.skillName) || slug,
    displayName: toStr(data?.DisplayName ?? data?.displayName) || slug,
    description: toStr(data?.Description ?? data?.description),
    securityStatus: toStr(data?.SecurityStatus ?? data?.securityStatus),
    auditStatus: toStr(security?.AuditStatus ?? security?.auditStatus),
    auditTime: toStr(security?.AuditTime ?? security?.auditTime),
    latestVersion: latest?.version ?? '',
    versions,
    ...(typeof requiresApiKey === 'boolean' ? { requiresApiKey } : {}),
    provider,
  };
}

function normalizeVersions(raw: RawSkillVersionItem[] | null | undefined): SkillVersionInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    version: toStr(item.Version ?? item.version),
    publishedAt: toStr(item.PublishedAt ?? item.publishedAt),
    changelog: toStr(item.Changelog ?? item.changelog),
    isLatest: (item.IsLatest ?? item.isLatest) === true,
  }));
}

function toStr(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}
