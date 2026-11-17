/**
 * Plugin text renderers — plain text output for `--format text`
 * (no ANSI, no borders).
 */

import type { PluginListViewModel } from '../../view-models/plugin/index.js';

export function renderTextPluginList(vm: PluginListViewModel): void {
  const lines: string[] = [];
  lines.push('  Installed Plugins');
  lines.push('');

  if (vm.isEmpty) {
    lines.push('  No plugins installed.');
    console.log(lines.join('\n'));
    return;
  }

  for (const row of vm.rows) {
    lines.push(`  ${row.name} (${row.version})`);
    lines.push(
      `     command: ${row.command}  \u00b7  source: ${row.source}  \u00b7  status: ${row.status}`,
    );
    lines.push('');
  }

  lines.push(`  ${vm.totalCount} plugins`);
  console.log(lines.join('\n'));
}
