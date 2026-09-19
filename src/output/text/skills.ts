/**
 * Skills text renderers — plain text output for `--format text`
 * (no ANSI, no borders).
 */

import type {
  PackInstallViewModel,
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
  lines.push(`  version: ${vm.version}`);
  lines.push(`  sha256: ${vm.sha256}`);
  lines.push(`  ${vm.modeLabel.toLowerCase()}: ${vm.modeValue}`);
  lines.push(`  location: ${vm.targetDir}`);
  lines.push(`  status: ${vm.statusLabel}`);
  if (vm.downgradeWarning) {
    lines.push(`  warning: ${vm.downgradeWarning}`);
  }
  if (vm.overrideNote) {
    lines.push(`  override: ${vm.overrideNote}`);
  }
  if (vm.apiKeyNotice) {
    lines.push(`  notice: ${vm.apiKeyNotice}`);
  }
  console.log(lines.join('\n'));
}

export function renderTextPackInstall(vm: PackInstallViewModel): void {
  const lines: string[] = [];
  lines.push('  Skills Pack Install');
  lines.push('');
  lines.push(`  ${vm.titleIcon} ${vm.titleText}`);

  if (vm.isAllNoop) {
    lines.push('');
    for (const item of vm.items) {
      lines.push(`  ${item.icon} ${item.fullSlug}  ${item.outcomeLabel}  ${item.versionLabel}`);
      if (item.overrideNote) {
        lines.push(`    override: ${item.overrideNote}`);
      }
    }
    lines.push('');
    lines.push(`  pack: ${vm.pack}`);
    lines.push(`  location: ${vm.baseDir}`);
  } else {
    lines.push('');
    for (const item of vm.items) {
      lines.push(`  ${item.icon} ${item.fullSlug}  ${item.outcomeLabel}  ${item.versionLabel}`);
      if (item.overrideNote) {
        lines.push(`    override: ${item.overrideNote}`);
      }
    }

    const rows: Array<[string, string]> = [
      ['Pack', vm.pack],
      [vm.modeLabel, vm.modeValue],
      [vm.baseDirLabel, vm.baseDir],
      ['Installed', String(vm.summary.installed)],
      ['Changed', String(vm.summary.changed)],
      ['Skipped', String(vm.summary.skipped)],
      ['Failed', String(vm.summary.failed)],
      ['Status', vm.statusLabel],
    ];
    lines.push('');
    for (const [label, value] of rows) {
      lines.push(`  ${label.padEnd(16)}${value}`);
    }

    if (vm.failedItems.length > 0) {
      lines.push('');
      lines.push('  Failed skills');
      for (const failed of vm.failedItems) {
        lines.push(`  \u2717 ${failed.fullSlug}  [${failed.code}] ${failed.message}`);
      }
    }
  }

  console.log(lines.join('\n'));
}
