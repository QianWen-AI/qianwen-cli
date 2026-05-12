/**
 * Text mode renderer for doctor command.
 * Pure text output (no ANSI colors, no borders) for --format text.
 * Receives ViewModel as input.
 */

import type { DoctorViewModel } from '../../view-models/doctor.js';
import { site } from '../../site.js';

const statusSymbol: Record<string, string> = {
  pass: '✓',
  fail: '✗',
  warn: '⚠',
  info: 'ℹ',
};

export function renderTextDoctor(vm: DoctorViewModel): void {
  const lines: string[] = [];

  lines.push(`  ${site.doctorTitle}  ·  v${vm.version}`);
  lines.push('');

  for (const check of vm.checks) {
    const symbol = statusSymbol[check.status] ?? '?';
    const detail = check.action ? `${check.detail}  ${check.action}` : check.detail;
    lines.push(`  ${symbol}  ${check.label.padEnd(20)}${detail}`);
  }

  lines.push('');
  lines.push(`  ${vm.footerMessage}`);
  lines.push('');

  console.log(lines.join('\n'));
}
