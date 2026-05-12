import React from 'react';
import { createClient } from '../../api/client.js';
import { resolveFormat } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError } from '../../utils/errors.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { InteractiveTable } from '../../ui/InteractiveTable.js';
import { renderInteractive } from '../../ui/render.js';
import {
  MODEL_LIST_COLUMNS,
  parsePaginationOptions,
  printPaginationFooter,
  buildModelRows,
} from './shared.js';
import { buildModelsUiData, renderModelsTableInk } from '../../ui/ModelsTable.js';
import { renderTextModelsList } from '../../output/text/models.js';
import { withSpinner } from '../../ui/spinner.js';

export interface ModelsSearchOptions {
  format?: string;
  page?: string;
  perPage?: string;
  all?: boolean;
}

export async function modelsSearchAction(
  query: string,
  options: ModelsSearchOptions,
): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);

  try {
    await ensureAuthenticated();
    const client = await createClient();

    // Parse pagination params
    const { page, perPage } = parsePaginationOptions(options.page, options.perPage);

    const { allModels, allModelsWithQuota } = await withSpinner(
      `Searching "${query}"`,
      async () => {
        const result = await client.searchModels(query);
        const allModels = result.models;
        const allModelsWithQuota =
          allModels.length > 0 ? await client.fetchQuotasForModels(allModels) : allModels;
        return { allModels, allModelsWithQuota };
      },
      format,
    );

    if (allModels.length === 0) {
      if (format === 'json') {
        printJSON({ models: [], total: 0, query });
      } else {
        console.log(`No models found matching '${query}'.`);
      }
      return;
    }

    const totalModels = allModels.length;
    const totalPages = Math.ceil(totalModels / perPage);

    if (format === 'json') {
      // --all: skip pagination entirely. See models/list.ts for the rationale.
      if (options.all) {
        printJSON({
          models: allModelsWithQuota,
          total: totalModels,
          all: true,
          query,
        });
        return;
      }

      // See models/list.ts for the rationale: don't clamp the page so Agents
      // can detect end-of-list vs a wrong page parameter.
      if (page > totalPages) {
        if (totalPages > 0) {
          process.stderr.write(
            `Warning: Requested page ${page} exceeds total pages (${totalPages}). No results to display.\n`,
          );
        }
        printJSON({
          models: [],
          total: totalModels,
          page,
          per_page: perPage,
          total_pages: totalPages,
          query,
        });
        return;
      }
      const startIndex = (page - 1) * perPage;
      const endIndex = startIndex + perPage;
      const pageModels = allModelsWithQuota.slice(startIndex, endIndex);
      printJSON({
        models: pageModels,
        total: totalModels,
        page,
        per_page: perPage,
        total_pages: totalPages,
        query,
      });
      return;
    }

    // Interactive mode: TTY + table format (--page sets initial page)
    const isInteractive = !!(process.stdout.isTTY && format !== 'text');

    if (isInteractive) {
      const loadPage = async (pageNum: number): Promise<Record<string, string>[]> => {
        const start = (pageNum - 1) * perPage;
        const pageModels = allModelsWithQuota.slice(start, start + perPage);

        // Fetch model details and quota in one call (reads from cache)
        const details = await client.getModels(pageModels.map((m) => m.id));

        const modelsWithQuota = pageModels.map((m, i) => details[i] ?? m);
        return buildModelRows(modelsWithQuota, details);
      };

      if (page > totalPages && totalPages > 0) {
        process.stderr.write(
          `Warning: Requested page ${page} exceeds total pages (${totalPages}), starting from last page.\n`,
        );
      }

      // Pre-load first page so initial render shows content immediately without loading state
      const initialRows = await loadPage(page);

      await renderInteractive(
        React.createElement(InteractiveTable, {
          columns: MODEL_LIST_COLUMNS,
          totalItems: allModels.length,
          perPage,
          loadPage,
          initialPage: page,
          initialRows,
          title: 'Models',
          subtitle: `Search: "${query}"`,
        }),
      );
      return;
    }

    // Non-interactive: static pagination for table/text modes
    const startIndex = (page - 1) * perPage;
    const endIndex = startIndex + perPage;
    const pageModels = allModelsWithQuota.slice(startIndex, endIndex);

    if (page > totalPages && totalPages > 0) {
      process.stderr.write(
        `Warning: Requested page ${page} exceeds total pages (${totalPages}). No results to display.\n`,
      );
    }

    // getModels reads quota from cache, no additional API requests needed
    const details = await client.getModels(pageModels.map((m) => m.id));

    const modelsWithQuota = pageModels.map((m, i) => details[i] ?? m);

    // Build UI data for consistent rendering (includes color metadata)
    const uiData = buildModelsUiData(modelsWithQuota, details);

    if (format === 'text') {
      renderTextModelsList(uiData);
    } else {
      // Table mode (Ink) — enhanced rendering with Section
      await renderModelsTableInk(uiData, {
        title: 'Models',
        subtitle: `Search: "${query}"`,
        footer: `${totalModels} models  ·  Page ${page} of ${totalPages}`,
      });
    }

    // Pagination footer (for all non-JSON modes)
    printPaginationFooter(page, totalPages, totalModels);
  } catch (error) {
    handleError(error, format);
  }
}
