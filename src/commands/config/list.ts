import chalk from 'chalk';
import { getConfigEntries } from '../../config/manager.js';
import { resolveFormat, outputJSON, outputText } from '../../output/format.js';
import { formatTextTable } from '../../output/text.js';
import { theme } from '../../ui/theme.js';
import { getConfigValue } from '../../config/manager.js';
import type { OutputFormat } from '../../types/config.js';

export interface ConfigListOptions {
  format?: string;
}

export function configList(opts: ConfigListOptions, parentFormat?: string): void {
  const format = resolveFormat(
    opts.format ?? parentFormat,
    getConfigValue('output.format') as OutputFormat,
  );

  const entries = getConfigEntries();

  if (format === 'json') {
    outputJSON({
      configs: entries.map((e) => ({
        key: e.key,
        value: e.value,
        source: e.source,
        ...(e.sourcePath ? { source_path: e.sourcePath } : {}),
      })),
    });
    return;
  }

  if (format === 'text') {
    const headers = ['Key', 'Value', 'Source'];
    const rows = entries.map((e) => [
      e.key,
      e.value,
      e.source + (e.sourcePath ? `  (${e.sourcePath})` : ''),
    ]);
    outputText(formatTextTable(headers, rows));
    return;
  }

  // Table (TTY) mode
  console.log('');
  console.log(`  ${theme.bold('Config')}  ${theme.dim(theme.symbols.dot)}  Effective`);

  const keyWidth = 18;
  const valWidth = 38;
  console.log(`  ${chalk.dim('Key'.padEnd(keyWidth))}${'Value'.padEnd(valWidth)}Source`);
  console.log(`  ${theme.dim(theme.symbols.dash.repeat(keyWidth + valWidth + 10))}`);

  for (const entry of entries) {
    const sourceLabel = entry.source === 'global' ? `global  (${entry.sourcePath})` : 'default';

    console.log(
      `  ${entry.key.padEnd(keyWidth)}${entry.value.padEnd(valWidth)}${theme.dim(sourceLabel)}`,
    );
  }
  console.log('');
}
