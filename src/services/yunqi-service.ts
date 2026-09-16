/** Yunqi (forum/exhibitor) service — wraps the MaasPortal yunqi POP APIs. */

import type { ApiClient } from '../api/api-client.js';
import { API_PRODUCT_MAAS_PORTAL } from '../types/api-routes.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import type {
  Exhibit,
  Exhibitor,
  ExhibitorListResult,
  ExhibitLocation,
  Forum,
  ForumGuest,
  ForumListResult,
  ForumSubscription,
  ForumSubscriptionListResult,
  ForumSummary,
  ForumTopic,
  ListExhibitorsOptions,
  ListForumsOptions,
  RawMaasPortalEnvelope,
} from '../types/yunqi.js';

export const FORUM_FILTER_KEYS = [
  'industry',
  'interest',
  'location',
  'forumId',
  'keyword',
  'forumName',
  'memberName',
  'themeName',
  'topicName',
  'guestName',
  'companyName',
] as const;

type ForumFilterKey = (typeof FORUM_FILTER_KEYS)[number];

export const EXHIBITOR_FILTER_KEYS = [
  'keyword',
  'companyName',
  'hallName',
  'zoneName',
  'boothName',
  'exhibitName',
] as const;

type ExhibitorFilterKey = (typeof EXHIBITOR_FILTER_KEYS)[number];

export class YunqiService {
  constructor(private readonly apiClient: ApiClient) {}

  async listForums(opts: ListForumsOptions = {}): Promise<ForumListResult> {
    const params: Record<string, unknown> = { Page: opts.page ?? 1, PageSize: opts.pageSize ?? 20 };
    for (const key of FORUM_FILTER_KEYS) {
      const value = opts[key];
      if (value) params[toPascalCase(key)] = value;
    }
    const raw = await this.apiClient.callFlatApi<RawMaasPortalEnvelope<unknown>>(
      API_PRODUCT_MAAS_PORTAL,
      'ListForums',
      params,
    );
    const data = unwrapMaasPortal(raw, 'ListForums');
    const { items, page: respPage, pageSize: respPageSize, total } = parsePageData(data);
    return {
      forums: items.map(normalizeForum),
      page: respPage,
      pageSize: respPageSize,
      total,
    };
  }

  async listExhibitors(opts: ListExhibitorsOptions = {}): Promise<ExhibitorListResult> {
    const params: Record<string, unknown> = { Page: opts.page ?? 1, PageSize: opts.pageSize ?? 20 };
    for (const key of EXHIBITOR_FILTER_KEYS) {
      const value = opts[key];
      if (value) params[toPascalCase(key)] = value;
    }
    if (opts.enabled !== undefined) params.Enabled = opts.enabled;
    const raw = await this.apiClient.callFlatApi<RawMaasPortalEnvelope<unknown>>(
      API_PRODUCT_MAAS_PORTAL,
      'ListExhibitors',
      params,
    );
    const data = unwrapMaasPortal(raw, 'ListExhibitors');
    const { items, page: respPage, pageSize: respPageSize, total } = parsePageData(data);
    return {
      exhibitors: items.map(normalizeExhibitor),
      page: respPage,
      pageSize: respPageSize,
      total,
    };
  }

  async subscribeForum(forumId: string): Promise<boolean> {
    const raw = await this.apiClient.callFlatApi<RawMaasPortalEnvelope<unknown>>(
      API_PRODUCT_MAAS_PORTAL,
      'SubscribeForum',
      { ForumId: forumId },
    );
    return toBoolean(unwrapMaasPortal(raw, 'SubscribeForum'));
  }

  async unsubscribeForum(forumId: string): Promise<boolean> {
    const raw = await this.apiClient.callFlatApi<RawMaasPortalEnvelope<unknown>>(
      API_PRODUCT_MAAS_PORTAL,
      'UnsubscribeForum',
      { ForumId: forumId },
    );
    return toBoolean(unwrapMaasPortal(raw, 'UnsubscribeForum'));
  }

  async listMyForumSubscriptions(): Promise<ForumSubscriptionListResult> {
    const raw = await this.apiClient.callFlatApi<RawMaasPortalEnvelope<unknown>>(
      API_PRODUCT_MAAS_PORTAL,
      'ListMyForumSubscriptions',
    );
    const data = asRecord(unwrapMaasPortal(raw, 'ListMyForumSubscriptions'));
    const items = Array.isArray(data.Items) ? data.Items : [];
    return {
      subscriptions: items.map(normalizeSubscription),
      notStartedCount: toNumber(data.NotStartedCount, 0),
      inProgressCount: toNumber(data.InProgressCount, 0),
      summaryPreparingCount: toNumber(data.SummaryPreparingCount, 0),
      summaryReadyCount: toNumber(data.SummaryReadyCount, 0),
      unviewedCount: toNumber(data.UnviewedCount, 0),
      extJson: extractStr(data.ExtJson),
    };
  }

  async listForumSummaries(forumId?: string): Promise<ForumSummary[]> {
    const params: Record<string, unknown> = {};
    if (forumId) params.ForumId = forumId;
    const raw = await this.apiClient.callFlatApi<RawMaasPortalEnvelope<unknown>>(
      API_PRODUCT_MAAS_PORTAL,
      'ListForumSummaries',
      params,
    );
    const data = unwrapMaasPortal(raw, 'ListForumSummaries');
    // parsePageData tolerates both the bare-array and `{ Items: [...] }` shapes
    // the backend has been switching between.
    return parsePageData(data).items.map(normalizeSummary);
  }
}

/**
 * `Number(code)` tolerates the gateway serializing the declared integer as
 * either `200` or `'200'`; a missing `Code` fails, so an empty envelope can
 * never degrade into a silent empty list. Throws CliError rather than
 * GatewayBusinessError because `classifyHttpError` hardcodes the latter to
 * `API_ERROR`, which would drop the backend's own code from `error.code`.
 */
function unwrapMaasPortal<T>(
  raw: RawMaasPortalEnvelope<T> | null | undefined,
  action: string,
): T | null {
  if (!raw || typeof raw !== 'object') {
    throw new CliError({
      code: 'EMPTY_RESPONSE',
      message: `${action} returned an empty response`,
      exitCode: EXIT_CODES.GENERAL_ERROR,
    });
  }
  const code = raw.Code;
  if (Number(code) !== 200) {
    const bizCode = String(code ?? 'UNKNOWN');
    throw new CliError({
      code: bizCode,
      message: raw.Message || `MaasPortal ${action} failed with code ${bizCode}`,
      exitCode: EXIT_CODES.GENERAL_ERROR,
      detail: raw.RequestId
        ? `${action} business code ${bizCode}\n  RequestId: ${raw.RequestId}`
        : `${action} business code ${bizCode}`,
    });
  }
  return raw.Data ?? null;
}

function normalizeForum(raw: unknown): Forum {
  const rec = raw as Record<string, unknown>;
  return {
    id: String(rec.ForumId ?? ''),
    name: String(rec.DisplayName ?? ''),
    theme: extractStr(rec.Theme),
    description: extractStr(rec.Description),
    startTime: extractStr(rec.StartTime),
    endTime: extractStr(rec.EndTime),
    location: extractStr(rec.Location),
    industryList: toStringArray(rec.IndustryList),
    interestList: toStringArray(rec.InterestList),
    technicalLevel: extractStr(rec.TechnicalLevel),
    topicList: Array.isArray(rec.TopicList) ? rec.TopicList.map(normalizeTopic) : undefined,
    liveAddress: extractStr(rec.LiveAddress),
    subscribable: toBoolean(rec.Subscribable),
    extJson: extractStr(rec.ExtJson),
  };
}

function normalizeTopic(raw: unknown): ForumTopic {
  const rec = raw as Record<string, unknown>;
  return {
    durationMinutes: extractStr(rec.DurationMinutes),
    topicTitle: extractStr(rec.TopicTitle),
    description: extractStr(rec.Description),
    guests: Array.isArray(rec.Guests) ? rec.Guests.map(normalizeGuest) : undefined,
  };
}

function normalizeGuest(raw: unknown): ForumGuest {
  const rec = raw as Record<string, unknown>;
  return {
    guestName: extractStr(rec.GuestName),
    guestTitle: extractStr(rec.GuestTitle),
    guestCompany: extractStr(rec.GuestCompany),
  };
}

function normalizeExhibitor(raw: unknown): Exhibitor {
  const rec = asRecord(raw);
  return {
    exhibits: Array.isArray(rec.Exhibits) ? rec.Exhibits.map(normalizeExhibit) : undefined,
    extJson: extractStr(rec.ExtJson),
  };
}

function normalizeExhibit(raw: unknown): Exhibit {
  const rec = asRecord(raw);
  return {
    exhibitId: extractStr(rec.ExhibitId),
    exhibitCode: extractStr(rec.ExhibitCode),
    name: extractStr(rec.Name),
    description: extractStr(rec.Description),
    hall: normalizeLocation(rec.Hall),
    zone: normalizeLocation(rec.Zone),
    booth: normalizeLocation(rec.Booth),
  };
}

function normalizeLocation(raw: unknown): ExhibitLocation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  return {
    code: extractStr(rec.Code),
    name: extractStr(rec.Name),
  };
}

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.map(String).filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizeSubscription(raw: unknown): ForumSubscription {
  const rec = raw as Record<string, unknown>;
  return {
    forumId: String(rec.ForumId ?? ''),
    forumName: String(rec.ForumName ?? ''),
    forumStartTime: String(rec.ForumStartTime ?? ''),
    forumEndTime: String(rec.ForumEndTime ?? ''),
    status: String(rec.Status ?? ''),
    statusText: String(rec.StatusText ?? ''),
    viewed: toBoolean(rec.Viewed),
    extJson: extractStr(rec.ExtJson),
  };
}

function normalizeSummary(raw: unknown): ForumSummary {
  const rec = raw as Record<string, unknown>;
  return {
    forumId: String(rec.ForumId ?? ''),
    summary: String(rec.Summary ?? ''),
    extJson: extractStr(rec.ExtJson),
  };
}

function parsePageData(parsed: unknown): {
  items: unknown[];
  page: number;
  pageSize: number;
  total: number;
} {
  if (Array.isArray(parsed)) {
    return { items: parsed, page: 1, pageSize: parsed.length, total: parsed.length };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    return {
      items: Array.isArray(obj.Items) ? obj.Items : [],
      page: toNumber(obj.Page, 1),
      pageSize: toNumber(obj.PageSize, 0),
      total: toNumber(obj.Total, 0),
    };
  }
  return { items: [], page: 1, pageSize: 0, total: 0 };
}

function toNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

// The gateway serializes per the cspec-declared type, not the backend Java type,
// so a Boolean field may arrive as either a JSON boolean or the string 'true'.
function toBoolean(v: unknown): boolean {
  return v === true || v === 'true';
}

// Truthiness would drop a legitimate `0` (e.g. DurationMinutes), so only
// null/undefined/'' count as absent.
function extractStr(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

function toPascalCase(key: ForumFilterKey | ExhibitorFilterKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}
