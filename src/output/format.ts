import type { Command } from 'commander';
import type { OutputFormat, ResolvedFormat, ConfigSchema } from '../types/config.js';

const VALID_FORMATS = ['auto', 'table', 'json', 'text'] as const;

/**
 * Resolve the output format based on priority:
 * 1. Explicit --format flag (highest priority) — searches command and ancestors
 * 2. Config output.format setting
 * 3. Auto-detect based on TTY
 *
 * Invalid --format values exit immediately with a structured error on stderr —
 * silently falling back to TUI (the previous behavior) corrupts Agent pipelines
 * that pass an unsupported format like `yaml`.
 */
export function resolveFormat(flagFormat?: string, configFormat?: OutputFormat): ResolvedFormat {
  // 1. Explicit flag
  if (flagFormat) {
    if (!isValidFormat(flagFormat)) {
      rejectInvalidFormat(flagFormat);
    }
    if (flagFormat === 'auto') {
      return detectTTYFormat();
    }
    return flagFormat as ResolvedFormat;
  }

  // 2. Config setting
  if (configFormat && configFormat !== 'auto') {
    return configFormat as ResolvedFormat;
  }

  // 3. Auto-detect
  return detectTTYFormat();
}

function rejectInvalidFormat(value: string): never {
  // Always emit JSON: a user passing --format presumably wants programmatic
  // output; a structured error is more useful than human prose here.
  const payload = {
    error: {
      code: 'INVALID_FORMAT',
      message: `Invalid format '${value}'. Supported: ${VALID_FORMATS.join(', ')}`,
      exit_code: 1,
    },
  };
  process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(1);
}

/**
 * Resolve format from a Commander command instance.
 * Walks up the parent chain to find --format flag at any level.
 * This handles cases like: `qianwen --format json usage summary`
 */
export function resolveFormatFromCommand(cmd: Command, config: ConfigSchema): ResolvedFormat {
  // Walk up parent chain to find --format flag
  let formatFlag: string | undefined;
  let current: Command | null = cmd;
  while (current) {
    const opts = current.opts();
    if (opts.format && typeof opts.format === 'string') {
      formatFlag = opts.format;
      break;
    }
    current = current.parent ?? null;
  }

  return resolveFormat(formatFlag, config['output.format']);
}

function detectTTYFormat(): ResolvedFormat {
  return process.stdout.isTTY ? 'table' : 'json';
}

function isValidFormat(format: string): boolean {
  return (VALID_FORMATS as readonly string[]).includes(format);
}

/**
 * Output data in the resolved format.
 * - json: JSON.stringify to stdout
 * - table: caller handles Ink rendering
 * - text: plain text output
 */
export function outputJSON(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function outputText(text: string): void {
  console.log(text);
}

// Errors must go to stderr so Agent pipelines (`cmd --format json | jq`) don't
// see error JSON mixed into the data stream.
export function outputErrorJSON(data: unknown): void {
  process.stderr.write(JSON.stringify(data, null, 2) + '\n');
}

/**
 * Format data as a plain-text table (no ANSI colors, no borders).
 * Used for --format text output.
 *
 * @param headers - Column header labels
 * @param rows - Array of row data (each row is an array of cell values)
 * @param padding - Left padding for each row (default: 2 spaces)
 * @returns Formatted table string
 */
export function formatTextTable(headers: string[], rows: string[][], padding: number = 2): string {
  const pad = ' '.repeat(padding);

  // Calculate column widths (header or max data cell per column)
  const colWidths = headers.map((h, i) => {
    const maxDataLen = rows.reduce((max, row) => {
      const cellLen = (row[i] ?? '').length;
      return Math.max(max, cellLen);
    }, 0);
    return Math.max(h.length, maxDataLen);
  });

  // Build header line
  const headerLine = pad + headers.map((h, i) => h.padEnd(colWidths[i])).join('  ');

  // Build data lines
  const dataLines = rows.map(
    (row) => pad + row.map((cell, i) => cell.padEnd(colWidths[i])).join('  '),
  );

  return [headerLine, ...dataLines].join('\n');
}
