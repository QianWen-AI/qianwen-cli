/**
 * Usage logs view-model — transforms the raw call-log DTO into render-friendly
 * rows. Pure data: no I/O, no React, no ANSI styling. The renderer layers
 * (Ink + plain text) read these fields verbatim.
 */

import type { UsageLogsResponse, UsageLogItem, UsageEntry } from '../types/usage.js';

export type UsageLogStatusColor = 'green' | 'yellow' | 'red';

export interface UsageLogRowViewModel {
  /** Local-timezone wall-clock string "YYYY-MM-DD HH:MM:SS" for full-time columns. */
  time: string;
  /** "HH:MM:SS" sliced from the time string for compact column rendering. */
  shortTime: string;
  /** Full request id; never truncated. */
  requestId: string;
  statusCode: number;
  statusColor: UsageLogStatusColor;
  model: string;
  /** "1.23 s" / "40 ms" */
  latencyDisplay: string;
  /** "456 ms" / "—" */
  firstOutputDisplay: string;
  /** "input: 100, output: 50" or "—" when nothing measured. */
  usage: string;
  errorCode: string | null;
}

export interface UsageLogsViewModel {
  periodLabel: string; // "YYYY-MM-DD HH:MM → YYYY-MM-DD HH:MM"
  totalCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
  items: UsageLogRowViewModel[];
  isEmpty: boolean;
}

const EM_DASH = '\u2014';

export function buildUsageLogsViewModel(data: UsageLogsResponse): UsageLogsViewModel {
  const items = data.items.map(toRow);
  const pageSize = data.pageSize > 0 ? data.pageSize : items.length;
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(data.totalCount / pageSize)) : 1;

  return {
    periodLabel: buildPeriodLabel(data.period?.from, data.period?.to),
    totalCount: data.totalCount,
    page: data.page,
    pageSize: data.pageSize,
    pageCount,
    items,
    isEmpty: data.totalCount === 0,
  };
}

function toRow(item: UsageLogItem): UsageLogRowViewModel {
  const time = item.createdAt || '';
  return {
    time: time ? formatFullTime(time) : EM_DASH,
    shortTime: time.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? EM_DASH,
    requestId: item.requestId || EM_DASH,
    statusCode: item.statusCode,
    statusColor: pickStatusColor(item.statusCode),
    model: item.model,
    latencyDisplay: formatLatency(item.durationMs),
    firstOutputDisplay:
      item.firstOutputDurationMs > 0 ? formatLatency(item.firstOutputDurationMs) : EM_DASH,
    usage: formatUsages(item.usages),
    errorCode: item.errorCode,
  };
}

/** Render an ISO8601 timestamp as a human-friendly "YYYY-MM-DD HH:MM:SS":
 *  drop the T separator and any trailing timezone designator (offset or Z). */
function formatFullTime(iso: string): string {
  return iso.replace('T', ' ').replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '');
}

function pickStatusColor(code: number): UsageLogStatusColor {
  if (code >= 200 && code < 300) return 'green';
  if (code >= 400 && code < 500) return 'yellow';
  return 'red';
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return EM_DASH;
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return `${ms} ms`;
}

function formatUsages(usages: UsageEntry[] | undefined): string {
  if (!Array.isArray(usages) || usages.length === 0) return EM_DASH;
  return usages.map((u) => `${u.key}: ${u.value}`).join(', ');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildPeriodLabel(from: string | undefined, to: string | undefined): string {
  if (!from && !to) return '';
  const fromLabel = from ? formatRangeBoundary(from) : '';
  const toLabel = to ? formatRangeBoundary(to) : '';
  return `${fromLabel} \u2192 ${toLabel}`.trim();
}

function formatRangeBoundary(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
