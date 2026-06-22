/**
 * `docs search` — keyword search against the public docs index.
 *
 * Routes to DocsService through the service container, then fans the result
 * out to the three rendering modes. The view-model layer handles partial /
 * degraded response diagnostics so the renderers stay declarative.
 */

import React from 'react';
import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { renderInteractive } from '../../ui/render.js';
import { createServices } from '../../services/index.js';
import {
  buildDocsSearchViewModel,
  buildDocContentViewModel,
} from '../../view-models/docs/index.js';
import { InteractiveDocsSearch } from '../../ui/InteractiveDocsSearch.js';
import { renderTextDocsSearch, renderTextDocContent } from '../../output/text/docs.js';
import { DocsViewerHost } from './view.js';
import { handleError } from '../../utils/errors.js';
import { site } from '../../site.js';
import type { DocsSearchOptions } from '../../services/docs-service.js';

const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;
const MAX_LIMIT = 100;
const TUI_PAGE_SIZE = 5;

function resolveLanguage(raw: unknown): 'en' | 'zh' {
  const v = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (v.startsWith('zh')) return 'zh';
  if (v === 'en') return 'en';
  return site.defaults.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function docsSearchAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, query: string, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      const trimmed = (query ?? '').trim();
      if (!trimmed) {
        process.stderr.write('Error: query is required.\n');
        process.exitCode = 2;
        return;
      }

      ensureAuthenticated();

      const rawLimit = clampLimit(options.limit);
      const effectiveLimit = format === 'table' ? Math.min(rawLimit, TUI_PAGE_SIZE) : rawLimit;
      const page = clampPage(options.page);
      const language = resolveLanguage(options.language);

      const { docsService } = createServices();
      const callOpts: DocsSearchOptions = {
        query: trimmed,
        limit: effectiveLimit,
        page,
        language,
      };
      const data = await withSpinner(
        'Searching docs',
        () => docsService.searchDocs(callOpts),
        format,
      );

      const vm = buildDocsSearchViewModel(data, {
        query: trimmed,
        page,
        pageSize: effectiveLimit,
        language,
      });

      const viewIndex = parseViewIndex(options.view);
      if (viewIndex !== null) {
        if (viewIndex < 1 || viewIndex > vm.items.length) {
          process.stderr.write(
            `Error: --view index ${viewIndex} is out of range (1..${vm.items.length}).\n`,
          );
          process.exitCode = 1;
          return;
        }
        const targetItem = vm.items[viewIndex - 1];
        if (targetItem.isDegraded || !targetItem.url) {
          process.stderr.write('Error: the selected item is unavailable.\n');
          process.exitCode = 1;
          return;
        }
        const result = await withSpinner(
          'Fetching document',
          () => docsService.fetchDocContent(targetItem.url),
          format,
        );
        if (format === 'json') {
          outputJSON({
            url: result.url,
            resolvedMarkdownUrl: result.resolvedMarkdownUrl,
            contentType: 'markdown',
            content: result.content,
            error: result.error,
          });
          if (result.error) process.exitCode = 1;
          return;
        }
        if (format === 'text') {
          renderTextDocContent(result);
          return;
        }
        const contentVm = buildDocContentViewModel(result);
        const noop = () => {};
        await renderInteractive(
          React.createElement(DocsViewerHost, {
            vm: contentVm,
            url: targetItem.url,
            onBack: noop,
            onQuit: noop,
          }),
        );
        return;
      }

      if (format === 'json') {
        outputJSON({
          query: vm.query,
          totalCount: vm.totalCount,
          page: vm.page,
          pageSize: vm.pageSize,
          items: vm.items,
          diagnostics: vm.diagnostics,
        });
        return;
      }

      if (format === 'text') {
        renderTextDocsSearch(vm);
        return;
      }

      await renderInteractive(
        React.createElement(InteractiveDocsSearch, {
          initialVm: vm,
          loadPage: async (pageNum: number) => {
            const next = await docsService.searchDocs({
              query: trimmed,
              limit: effectiveLimit,
              page: pageNum,
              language,
            });
            return buildDocsSearchViewModel(next, {
              query: trimmed,
              page: pageNum,
              pageSize: effectiveLimit,
              language,
            });
          },
          fetchContent: async (url: string) => {
            const result = await docsService.fetchDocContent(url);
            return buildDocContentViewModel(result);
          },
        }),
      );
    } catch (error) {
      handleError(error, format);
    }
  };
}

export function registerDocsSearchCommand(parent: Command): Command {
  const search = parent
    .command('search <query>')
    .description('Search the official docs by keyword')
    .option('--limit <n>', 'Page size (1..100)', (v) => parseInt(v, 10), DEFAULT_LIMIT)
    .option('--page <n>', 'Page number', (v) => parseInt(v, 10), DEFAULT_PAGE)
    .option('--language <lang>', 'Language: en | zh (default from config)')
    .option('--view <index>', 'View content of search result at given index (1-based)')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  search.action(docsSearchAction(search));
  return search;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function clampPage(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_PAGE;
}

function parseViewIndex(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}
