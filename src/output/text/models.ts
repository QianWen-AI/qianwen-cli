/**
 * Text mode renderers for models commands.
 * Pure text output (no ANSI colors, no borders) for --format text.
 * Receives ViewModel as input.
 */

import type { ModelsListViewModel, ModelDetailViewModel } from '../../view-models/models.js';
import { formatTextTable } from '../text.js';
import { MODEL_LIST_COLUMNS } from '../../commands/models/shared.js';

// ── Models List Text Renderer ────────────────────────────────────────

export function renderTextModelsList(vm: ModelsListViewModel): void {
  const headers = MODEL_LIST_COLUMNS.map((c) => c.header);
  const rows = vm.rows.map((row) => {
    const r = row as unknown as Record<string, string>;
    return MODEL_LIST_COLUMNS.map((c) => r[c.key] ?? '');
  });

  console.log(formatTextTable(headers, rows));
  console.log(`  ${vm.total} models`);
}

// ── Models Info Text Renderer ────────────────────────────────────────

export function renderTextModelDetail(vm: ModelDetailViewModel): void {
  const lines: string[] = [];

  // Header
  lines.push(`  ${vm.id}`);
  lines.push('');
  lines.push(`  ${vm.description}`);
  if (vm.tags !== '—') {
    lines.push(`  Tags: ${vm.tags}`);
  }
  lines.push('');

  // Modality
  lines.push('  ── Modality ──');
  lines.push(`  Input    ${vm.modalityInput}`);
  lines.push(`  Output   ${vm.modalityOutput}`);
  lines.push('');

  // Features
  lines.push('  ── Features ──');
  lines.push(`  ${vm.features}`);
  lines.push('');

  // Pricing
  lines.push('  ── Pricing ──');
  if (vm.pricingType === 'llm') {
    // LLM pricing table
    const hasCache = vm.pricingLines.some((l) => l.cells.cacheCreation != null);
    const headers = hasCache
      ? ['Context Length', 'Input', 'Output', 'Cache Creation', 'Cache Read']
      : ['Context Length', 'Input', 'Output'];

    const rows = vm.pricingLines.map((l) => {
      const row = [l.cells.label, l.cells.input, l.cells.output];
      if (hasCache) {
        row.push(l.cells.cacheCreation ?? '—', l.cells.cacheRead ?? '—');
      }
      return row;
    });

    lines.push('  ' + formatTextTable(headers, rows, 0).replace(/^ {2}/gm, ''));

    // Built-in tools
    if (vm.builtInTools.length > 0) {
      lines.push('');
      lines.push('  Built-in Tools');
      const toolRows = vm.builtInTools.map((t) => [t.name, t.price, `(${t.api})`]);
      lines.push(
        '  ' +
          formatTextTable(['', '', ''], toolRows, 0)
            .replace(/^ {2}/gm, '')
            .split('\n')
            .map((l, i) => {
              const tool = vm.builtInTools[i];
              if (!tool) return l;
              return `  ${tool.name.padEnd(20)}${tool.price.padStart(12)}  (${tool.api})`;
            })
            .join('\n'),
      );
    }
  } else if (vm.pricingType === 'video') {
    const toolRows = vm.pricingLines.map((l) => [l.cells.resolution, l.cells.price]);
    lines.push('  ' + formatTextTable(['Resolution', 'Price'], toolRows, 0).replace(/^ {2}/gm, ''));
  } else {
    // Single-line pricing (image, tts, asr, embedding)
    const firstLine = vm.pricingLines[0];
    if (firstLine) {
      lines.push(`  ${firstLine.cells.label || firstLine.cells.price}`);
    }
  }
  lines.push('');

  // Context (LLM only)
  if (vm.context) {
    lines.push('  ── Context ──');
    lines.push(`  Context Window  ${vm.context.window}`);
    lines.push(`  Max Input       ${vm.context.maxInput}`);
    lines.push(`  Max Output      ${vm.context.maxOutput}`);
    lines.push('');
  }

  // Rate Limits
  lines.push('  ── Rate Limits ──');
  lines.push(`  ${vm.rateLimits}`);
  lines.push('');

  // Free Tier
  if (vm.freeTier) {
    lines.push('  ── Free Tier ──');
    if (vm.freeTier.mode === 'only') {
      lines.push('  Free (Early Access) — no paid option');
    } else if (vm.freeTier.remaining !== undefined && vm.freeTier.remainingPct !== undefined) {
      lines.push(
        `  ${vm.freeTier.total ?? '—'}  ·  ${vm.freeTier.remaining} remaining (${vm.freeTier.remainingPct}%)`,
      );
      if (vm.freeTier.resetDate) {
        lines.push(`  Resets: ${vm.freeTier.resetDate}`);
      }
    } else {
      lines.push('  Quota data unavailable');
    }
    lines.push('');
  }

  // Metadata
  lines.push('  ── Metadata ──');
  lines.push(
    `  Version    ${vm.metadata.version}    Open Source  ${vm.metadata.openSource}    Updated  ${vm.metadata.updated}`,
  );
  lines.push('');

  console.log(lines.join('\n'));
}
