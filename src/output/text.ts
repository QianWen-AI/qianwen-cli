/**
 * Plain text output helpers (no ANSI colors, no borders).
 * Used for --format text (LLM-friendly output).
 */

// Re-export from format.ts for backwards compatibility
export { formatTextTable } from './format.js';

/**
 * Print plain text to stdout.
 */
export function printText(text: string): void {
  console.log(text);
}

/**
 * Format a simple key-value list as text.
 */
export function formatKeyValue(entries: Array<[string, string]>, indent: number = 2): string {
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  return entries
    .map(([key, value]) => `${' '.repeat(indent)}${key.padEnd(maxKeyLen + 2)}${value}`)
    .join('\n');
}

/**
 * Format a section title for text mode.
 */
export function formatSectionTitle(title: string, subtitle?: string, width: number = 80): string {
  const titlePart = subtitle ? `${title}  ·  ${subtitle}` : title;
  const dashes = '─'.repeat(Math.max(0, width - titlePart.length - 4));
  return `  ── ${titlePart}${dashes}`;
}

/**
 * Format a section footer for text mode.
 */
export function formatSectionFooter(text: string, width: number = 80): string {
  return `  ${'─'.repeat(width)}\n  ${text}`;
}
