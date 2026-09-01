/** Normalize a wall-clock timestamp string to ISO8601 form; unrecognized inputs pass through verbatim. */
export function normalizeTimestamp(raw: string): string {
  if (!raw) return raw;
  if (raw.includes('T')) return raw;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  if (match) return `${match[1]}T${match[2]}Z`;
  return raw;
}

/**
 * Convert a millisecond Unix timestamp to a local-timezone ISO8601 string.
 *
 * Example: 1781289590894 → "2026-06-13T10:39:50+08:00" (when running in UTC+8)
 *
 * Returns an empty string for non-finite or out-of-range inputs.
 */
export function unixMsToLocalIso(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
  const om = pad(Math.abs(offsetMin) % 60);
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
}
