/** Redact a token for debug output, exposing minimal prefix/suffix based on length. */
export function redactToken(value: string): string {
  if (!value) return '***';
  const len = value.length;
  if (len <= 8) return '***';
  if (len <= 16) return value.slice(0, 4) + '****';
  const prefixLen = value[7] === '.' || value[7] === '-' ? 8 : 7;
  return value.slice(0, prefixLen) + '****' + value.slice(-4);
}

/**
 * Redact a Bearer header value while preserving the 'Bearer ' prefix
 * for debug-output readability.
 */
export function redactBearer(value: string): string {
  const token = value.replace(/^Bearer\s+/i, '');
  return `Bearer ${redactToken(token)}`;
}
