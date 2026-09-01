/**
 * Plain text output helpers (no ANSI colors, no borders).
 * Used for --format text (LLM-friendly output).
 */

export { formatTextTable } from './format.js';

/**
 * Format a simple key-value list as text.
 */
export function formatKeyValue(entries: Array<[string, string]>, indent: number = 2): string {
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  return entries
    .map(([key, value]) => `${' '.repeat(indent)}${key.padEnd(maxKeyLen + 2)}${value}`)
    .join('\n');
}
