/**
 * `docs view` — fetch a single docs page by relative path or absolute URL
 * and render it through the same TUI/TEXT/JSON triad as `docs search --view`.
 *
 * The path is resolved against the configured docs base; absolute http(s)
 * URLs pass through unchanged so users can paste a link verbatim.
 */

import React from 'react';
import { useApp } from 'ink';
import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { withSpinner } from '../../ui/spinner.js';
import { buildDocContentViewModel } from '../../view-models/docs/index.js';
import type { DocContentViewModel } from '../../view-models/docs/index.js';
import { DocsViewer } from '../../ui/DocsViewer.js';
import { renderInteractive } from '../../ui/render.js';
import { renderTextDocContent } from '../../output/text/docs.js';
import { handleError, HandledError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { createServices } from '../../services/index.js';
import { buildDocsUrl, resolveDocPath } from '../../services/docs-service.js';
import type { DocsIndexEntry, ResolveResult } from '../../types/docs.js';

const EXIT_NOT_FOUND = 10;

interface DocsViewerHostProps {
  vm: DocContentViewModel;
  url: string;
  onBack: () => void;
  onQuit: () => void;
}

export function DocsViewerHost({ vm, url, onBack, onQuit }: DocsViewerHostProps) {
  const { exit } = useApp();
  const handleBack = () => {
    exit();
    onBack();
  };
  const handleQuit = () => {
    exit();
    onQuit();
  };
  return React.createElement(DocsViewer, { vm, url, onBack: handleBack, onQuit: handleQuit });
}

export function docsViewAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, path: string, _options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      const trimmed = (path ?? '').trim();
      if (!trimmed) {
        process.stderr.write('Error: path is required.\n');
        throw new HandledError(EXIT_CODES.GENERAL_ERROR);
      }

      const { docsService } = createServices();

      const isFullUrl = /^https?:\/\//i.test(trimmed);
      if (isFullUrl) {
        try {
          const hostname = new URL(trimmed).hostname;
          if (hostname !== 'qianwenai.com' && !hostname.endsWith('.qianwenai.com')) {
            process.stderr.write('Error: cannot open this document.\n');
            throw new HandledError(EXIT_CODES.GENERAL_ERROR);
          }
        } catch (e) {
          if (e instanceof HandledError) throw e;
          process.stderr.write('Error: invalid URL format.\n');
          throw new HandledError(EXIT_CODES.GENERAL_ERROR);
        }
      }
      let index: DocsIndexEntry[] = [];
      let resolveResult: ResolveResult | null = null;
      if (!isFullUrl) {
        try {
          index = await docsService.loadDocsIndex();
        } catch {
          index = [];
        }
        if (index.length > 0) {
          resolveResult = resolveDocPath(trimmed, index);
          if (resolveResult.type === 'ambiguous') {
            emitCandidates(trimmed, resolveResult.candidates, format);
            return;
          }
        }
      }

      const url =
        resolveResult && resolveResult.type === 'exact'
          ? resolveResult.url.replace(/\.md(#|$)/, '$1')
          : buildDocsUrl(trimmed);
      const result = await withSpinner(
        'Fetching document',
        () => docsService.fetchDocContent(url),
        format,
      );

      // Error / failure classification
      if (result.error) {
        const isNotFound = /(^|\D)404(\D|$)/.test(result.error);
        const isTimeout = /timed?\s*out/i.test(result.error);
        const exitCode = isTimeout ? EXIT_CODES.NETWORK_ERROR : EXIT_NOT_FOUND;

        const suggestions: DocsIndexEntry[] =
          isNotFound && resolveResult && resolveResult.type === 'notfound'
            ? resolveResult.suggestions
            : [];

        if (format === 'json') {
          outputJSON({
            url: result.url,
            resolvedMarkdownUrl: result.resolvedMarkdownUrl,
            contentType: 'markdown',
            content: result.content,
            anchor: result.anchor,
            error: result.error,
            suggestions: suggestions.length > 0 ? suggestions : undefined,
          });
        } else if (isNotFound) {
          process.stderr.write(`Error: Document not found at "${trimmed}"\n`);
          if (suggestions.length > 0) {
            process.stderr.write('\nDid you mean?\n');
            suggestions.forEach((s, i) => {
              const desc = s.description ? ` — ${s.description}` : '';
              process.stderr.write(`  ${i + 1}. ${s.path}${desc}\n`);
            });
            process.stderr.write(`\nTry: qianwen docs view ${suggestions[0].path}\n`);
            process.stderr.write(`  or: qianwen docs search "${trimmed}"\n`);
          }
        } else if (isTimeout) {
          process.stderr.write(
            `Error: ${result.error}. Try \`qianwen doctor\` to diagnose network issues.\n`,
          );
        } else {
          process.stderr.write(
            `Error: ${result.error} (attempted ${result.resolvedMarkdownUrl})\n`,
          );
        }
        throw new HandledError(exitCode);
      }

      if (result.content === null || result.content.length === 0) {
        const emptyMessage = `Document content is empty (${result.resolvedMarkdownUrl})`;
        if (format === 'json') {
          outputJSON({
            url: result.url,
            resolvedMarkdownUrl: result.resolvedMarkdownUrl,
            contentType: 'markdown',
            content: result.content ?? '',
            anchor: result.anchor,
            error: emptyMessage,
          });
        } else {
          process.stderr.write(`Error: ${emptyMessage}\n`);
        }
        throw new HandledError(EXIT_NOT_FOUND);
      }

      if (format === 'json') {
        outputJSON({
          url: result.url,
          resolvedMarkdownUrl: result.resolvedMarkdownUrl,
          contentType: 'markdown',
          content: result.content,
          anchor: result.anchor,
          error: result.error,
        });
        return;
      }

      if (format === 'text') {
        renderTextDocContent(result);
        return;
      }

      const vm = buildDocContentViewModel(result);
      const noop = () => {};
      await renderInteractive(
        React.createElement(DocsViewerHost, {
          vm,
          url: result.url,
          onBack: noop,
          onQuit: noop,
        }),
      );
    } catch (error) {
      if (error instanceof HandledError) throw error;
      handleError(error, format);
    }
  };
}

function emitCandidates(input: string, candidates: DocsIndexEntry[], format: string): void {
  if (format === 'json') {
    outputJSON({ input, candidates });
    return;
  }
  process.stdout.write(`Multiple documents matched "${input}":\n\n`);
  candidates.forEach((c, i) => {
    const desc = c.description ? ` — ${c.description}` : '';
    process.stdout.write(`  ${i + 1}. ${c.path}${desc}\n`);
  });
  if (candidates.length > 0) {
    process.stdout.write(`\nTry: qianwen docs view ${candidates[0].path}\n`);
  }
}

export function registerDocsViewCommand(parent: Command): Command {
  const view = parent
    .command('view <path>')
    .description('View a docs page by path or URL')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  view.action(docsViewAction(view));
  return view;
}
