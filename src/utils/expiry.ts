/** Derive a human-friendly validity window from a signed asset URL. */

/**
 * Parse the `Expires=<unix-seconds>` query parameter of a signed OSS URL and
 * express the remaining lifetime as a rounded `"<n>h"` (or `"<n>m"` under an
 * hour) string. Returns undefined when the URL carries no parsable expiry.
 */
export function expiresInFromUrl(
  url: string | undefined,
  now: number = Date.now(),
): string | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  const match = /[?&]Expires=(\d+)/.exec(url);
  if (match === null) return undefined;
  const expiresSec = Number(match[1]);
  if (!Number.isFinite(expiresSec)) return undefined;
  const remainingMs = expiresSec * 1000 - now;
  if (remainingMs <= 0) return undefined;
  const hours = Math.round(remainingMs / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  return `${minutes}m`;
}
