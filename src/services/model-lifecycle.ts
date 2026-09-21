/**
 * Model retirement semantics derived from the `ListModelSeries` payload. The
 * list/detail views read `lifecycle` off each model to mark retiring entries,
 * render the Lifecycle line and the Notices footer.
 */

import type { Model } from '../types/model.js';
import { ANNOUNCEMENT_URL, formatRetireDateLong } from './model-deprecation-source.js';

/** Only surface retirement notices when the offline instant is within this window. */
export const RETIRE_NOTICE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Parse an upstream retirement time (ISO 8601 or `yyyy-MM-dd HH:mm:ss`) to epoch ms, or null. */
export function parseOfflineTime(value?: string): number | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso =
    /^\d{4}-\d{2}-\d{2}[ T]/.test(trimmed) && !trimmed.includes('T')
      ? trimmed.replace(' ', 'T')
      : trimmed;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/** True when the model has a retirement time that has not yet passed. */
export function isModelRetiring(
  model: Pick<Model, 'lifecycle'>,
  now: number = Date.now(),
): boolean {
  const at = parseOfflineTime(model.lifecycle?.offline_time);
  return at != null && now < at && at - now <= RETIRE_NOTICE_WINDOW_MS;
}

/** The raw retirement time string for a model still scheduled to retire, else null. */
export function modelRetireTime(
  model: Pick<Model, 'lifecycle'>,
  now: number = Date.now(),
): string | null {
  return isModelRetiring(model, now) ? (model.lifecycle?.offline_time ?? null) : null;
}

/** Format the retirement date of a retiring model as `Month D, YYYY`, else null. */
export function modelRetireDateLong(
  model: Pick<Model, 'lifecycle'>,
  now: number = Date.now(),
): string | null {
  const raw = modelRetireTime(model, now);
  return raw ? formatRetireDateLong(raw) : null;
}

/** Announcement link surfaced for a retiring model — always the site changelog anchor. */
export function resolveAnnouncementUrl(): string {
  return ANNOUNCEMENT_URL;
}
