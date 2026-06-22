/**
 * Docs search text renderer — plain text grouped output for `--format text`.
 * Strips `<em>` highlight tags; surfaces a single banner when the response
 * is broadly degraded.
 */

import type { DocsSearchViewModel } from '../../view-models/docs/index.js';
import type { DocContentResult } from '../../types/docs.js';

export function renderTextDocsSearch(vm: DocsSearchViewModel): void {
  const lines: string[] = [];
  lines.push(`  Docs Search  \u00b7  "${vm.query}"`);
  lines.push('');

  if (vm.isEmpty) {
    lines.push('  No results.');
    console.log(lines.join('\n'));
    return;
  }

  if (vm.isAllDegraded) {
    lines.push(`  ${vm.degradedPlaceholder}, please retry later.`);
    console.log(lines.join('\n'));
    return;
  }

  if (vm.diagnostics.includes('search.fields_incomplete')) {
    lines.push(`  Note: ${vm.degradedPlaceholder}.`);
    lines.push('');
  }

  for (const item of vm.items) {
    if (item.isDegraded) {
      lines.push(`  - ${vm.degradedPlaceholder}`);
      lines.push('');
      continue;
    }
    const prefix = item.subBizType ? `${item.subBizType} ` : '';
    lines.push(`  - ${prefix}${item.title}`);
    if (item.url) {
      lines.push(`    ${item.url}`);
    }
    if (item.breadcrumb && item.breadcrumb.length > 0) {
      lines.push(`    ${item.breadcrumb.join(' > ')}`);
    }
    if (item.summary) {
      lines.push(`    ${item.summary}`);
    }
    lines.push('');
  }

  lines.push(`  ${vm.totalCount} results  \u00b7  Page ${vm.page} of ${vm.pageCount}`);
  console.log(lines.join('\n'));
}

export function renderTextDocContent(result: DocContentResult): void {
  const lines: string[] = [];

  lines.push('---');
  lines.push(`Source: ${result.url}`);
  lines.push('---');
  lines.push('');

  if (result.content) {
    lines.push(result.content);
  } else {
    process.stderr.write(`Error: ${result.error}\n`);
    process.stderr.write(`Attempted URL: ${result.resolvedMarkdownUrl}\n`);
    process.exitCode = 1;
  }

  console.log(lines.join('\n'));
}
