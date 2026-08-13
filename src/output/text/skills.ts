/**
 * Skills text renderers — plain text output for `--format text`
 * (no ANSI, no borders).
 */

import type {
  SkillsInstallViewModel,
  SkillsSearchViewModel,
} from '../../view-models/skills/index.js';

export function renderTextSkillsSearch(vm: SkillsSearchViewModel): void {
  const lines: string[] = [];
  lines.push(`  Skills Search  \u00b7  "${vm.query}"`);
  lines.push('');

  if (vm.isEmpty) {
    lines.push('  No results.');
    console.log(lines.join('\n'));
    return;
  }

  for (const row of vm.rows) {
    lines.push(`  ${row.index}. ${row.name} (${row.slug})`);
    if (row.description) {
      lines.push(`     ${row.description}`);
    }
    lines.push(
      `     publisher: ${row.publisher}  \u00b7  version: ${row.currentVersion}  \u00b7  verified: ${row.verified ? 'yes' : 'no'}`,
    );
    lines.push('');
  }

  lines.push(`  ${vm.totalCount} skills`);
  console.log(lines.join('\n'));
}

export function renderTextSkillsInstall(vm: SkillsInstallViewModel): void {
  const lines: string[] = [];
  lines.push('  Skills Install');
  lines.push('');
  lines.push(`  ${vm.resultLine}`);
  lines.push('');
  lines.push(`  skill: ${vm.slug}`);
  lines.push(`  ${vm.modeLabel.toLowerCase()}: ${vm.modeValue}`);
  lines.push(`  location: ${vm.targetDir}`);
  lines.push(`  status: ${vm.statusLabel}`);
  if (vm.downgradeWarning) {
    lines.push(`  warning: ${vm.downgradeWarning}`);
  }
  console.log(lines.join('\n'));
}
