/** Workspace listing and limit orchestration. */
import type { ApiClient } from '../api/api-client.js';
import type { Workspace, WorkspaceListResult, WorkspaceLimitResult } from '../types/workspace.js';
import { unixMsToLocalIso } from '../utils/timestamp.js';

interface WorkspaceListResponse {
  data?: Array<Record<string, unknown>>;
  items?: Partial<Workspace>[];
  totalCount?: number;
  total?: number;
}

interface WorkspaceLimitResponse {
  current?: number;
  max?: number;
  result?: number;
}

const LIST_API = 'zeldaEasy.bailian-dash-workspace.space.listWorkspaces4Agent';
const LIMIT_API = 'zeldaEasy.bailian-dash-workspace.space.getWorkspaceLimitNumber';

export class WorkspaceService {
  constructor(private readonly apiClient: ApiClient) {}

  async list(): Promise<WorkspaceListResult> {
    const [base, quota] = await Promise.all([this.fetchListBase(), this.fetchQuota()]);
    return { ...base, limit: extractQuotaMax(quota) };
  }

  async limit(): Promise<WorkspaceLimitResult> {
    // The quota endpoint returns either a bare number or `{ max }`; it does
    // not expose the in-use count. Derive `current` from the workspace list
    // total in the same round-trip via Promise.all to avoid serial latency.
    const [data, listResult] = await Promise.all([this.fetchQuota(), this.fetchListBase()]);
    const max = extractQuotaMax(data);
    // Forward-compat: prefer `current` from the quota endpoint if a future
    // backend revision starts returning it; otherwise fall back to the
    // workspace list total.
    const current =
      typeof data !== 'number' && typeof data?.current === 'number'
        ? data.current
        : listResult.total;
    return { current, max };
  }

  /** List items + total, without quota — shared between `list()` and any
   *  future caller that wants to skip the quota round-trip. */
  private async fetchListBase(): Promise<{ items: Workspace[]; total: number }> {
    const data = await this.apiClient.callEnvelopeApi<WorkspaceListResponse | null>({
      api: LIST_API,
      data: { pageNo: 1, pageSize: 200 },
    });
    const rawItems = data?.data ?? data?.items ?? [];
    const items = rawItems.map(normalizeWorkspaceItem);
    return {
      items,
      total: data?.totalCount ?? data?.total ?? items.length,
    };
  }

  /** Raw quota fetch — shared between `list()` and `limit()`. */
  private fetchQuota(): Promise<WorkspaceLimitResponse | number | null> {
    return this.apiClient.callEnvelopeApi<WorkspaceLimitResponse | number | null>({
      api: LIMIT_API,
      data: {},
    });
  }
}

function extractQuotaMax(data: unknown): number {
  if (typeof data === 'number') return Number.isFinite(data) ? data : 0;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.max === 'number') return obj.max;
    if (typeof obj.result === 'number') return obj.result;
  }
  return 0;
}

function normalizeWorkspaceItem(raw: Partial<Workspace> | Record<string, unknown>): Workspace {
  const rec = raw as Record<string, unknown>;
  return {
    id: toStr(rec.id ?? rec.workspaceId),
    name: toStr(rec.name ?? rec.workspaceName ?? rec.agentName),
    region: toStr(rec.region ?? rec.workspaceRegion),
    createdAt: toTimestampStr(rec.createdAt ?? rec.gmtCreate ?? rec.createTime),
    isDefault: Boolean(rec.isDefault ?? rec.defaultAgent ?? false),
    tenantId: toNumber(rec.tenantId),
  };
}

function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * Coerce upstream createdAt-style fields to a printable string.
 * Numeric values are interpreted as Unix-ms timestamps and rendered via
 * the shared local-ISO formatter; strings pass through unchanged so
 * existing ISO8601 payloads stay intact.
 */
function toTimestampStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return unixMsToLocalIso(v);
  if (typeof v === 'string') return v;
  return '';
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
