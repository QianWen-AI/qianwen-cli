import { visibleWidth } from '../../ui/textWrap.js';

const EM_DASH = '\u2014';
const ELLIPSIS = '\u2026';

/**
 * Truncate a title so its terminal display width does not exceed `maxWidth`
 * columns, appending an ellipsis when truncation occurs. Width is measured
 * in terminal columns (CJK fullwidth = 2, ASCII = 1) via visibleWidth.
 */
export function truncateTitle(title: string, maxWidth: number = 36): string {
  if (!title) return EM_DASH;
  const normalized = title.replace(/[\r\n]+/g, ' ');
  if (visibleWidth(normalized) <= maxWidth) return normalized;
  // Trim code-point by code-point until width budget (reserve 1 col for ellipsis).
  const cps = Array.from(normalized);
  let out = '';
  for (const cp of cps) {
    const next = out + cp;
    if (visibleWidth(next) + 1 > maxWidth) break;
    out = next;
  }
  return out + ELLIPSIS;
}

/** Format a millisecond timestamp to local YYYY-MM-DD HH:mm. */
export function formatTicketTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return EM_DASH;
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// Ticket status mapping (raw → display). Inlined from the planned
// support-service layer so this view-model has no service dependency.
const TICKET_STATUS_MAP: Record<string, string> = {
  wait_assign: 'Pending assignment',
  assigned: 'Assigned',
  dealing: 'Processing',
  wait_feedback: 'Pending feedback',
  feedback: 'Pending feedback',
  wait_confirm: 'Pending confirmation',
  wait_score: 'Pending rating',
  confirmed: 'Closed',
  score: 'Closed',
  robot_dealing: 'Processing',
  robot_waiting_confirmation: 'Pending confirmation',
  robot_processing: 'Processing',
};

export function formatStatus(rawStatus: string): string {
  if (!rawStatus) return 'Unknown';
  const mapped = TICKET_STATUS_MAP[rawStatus];
  if (mapped) return mapped;
  return rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1).replace(/_/g, ' ');
}

/**
 * Mask an email-shaped identifier, preserving the first character of the local
 * part and the full domain (`a***@domain`). Values without an `@` are returned
 * unchanged. An empty local part degrades to `***@domain`.
 */
export function maskEmail(value: string): string {
  if (!value) return value;
  const at = value.indexOf('@');
  if (at < 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local.length > 0 ? local[0] : '';
  return `${head}***@${domain}`;
}
