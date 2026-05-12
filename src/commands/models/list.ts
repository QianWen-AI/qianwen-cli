import React from 'react';
import { createClient } from '../../api/client.js';
import type { ListModelsOptions } from '../../api/client.js';
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
import { validateModalityFlag } from '../../utils/modality.js';

export interface ModelsListOptions {
  input?: string;
  output?: string;
  format?: string;
  page?: string;
  perPage?: string;
  all?: boolean;
  verbose?: boolean;
}

export async function modelsListAction(options: ModelsListOptions): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);

  try {
    if (options.input) validateModalityFlag('--input', options.input);
    if (options.output) validateModalityFlag('--output', options.output);

    await ensureAuthenticated();
    const client = await createClient();
    const listOpts: ListModelsOptions = {
      input: options.input,
      output: options.output,
    };

    // Parse pagination params
    const { page, perPage } = parsePaginationOptions(options.page, options.perPage);

    // For table/text modes, we need pricing info, so fetch full details
    // For JSON mode, just return the list response directly
    if (format === 'json') {
      const result = await client.listModels(listOpts);
      if (result.models.length === 0) {
        printJSON({ models: [], total: 0, page: 1, per_page: perPage, total_pages: 0 });
        return;
      }
      const allModelsWithQuota = await client.fetchQuotasForModels(result.models);
      const totalModels = allModelsWithQuota.length;
      const totalPages = Math.ceil(totalModels / perPage);

      // --all: skip pagination entirely. Returns ~130KB for 220 models, but
      // saves an Agent ~22s of sequential pagination round-trips when it
      // wants to compare candidates across the whole catalog.
      if (options.all) {
        const slice = options.verbose
          ? await enrichWithDetails(client, allModelsWithQuota)
          : allModelsWithQuota;
        printJSON({
          models: slice,
          total: totalModels,
          all: true,
        });
        return;
      }

      // Don't clamp page: an Agent paginating with `--page N` needs to be able
      // to detect the end of the list (empty `models` with `page > total_pages`)
      // distinct from "I asked for the wrong page and got something silently".
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
        });
        return;
      }
      const startIndex = (page - 1) * perPage;
      const endIndex = startIndex + perPage;
      const pageModelsBase = allModelsWithQuota.slice(startIndex, endIndex);
      const pageModels = options.verbose
        ? await enrichWithDetails(client, pageModelsBase)
        : pageModelsBase;
      printJSON({
        models: pageModels,
        total: totalModels,
        page,
        per_page: perPage,
        total_pages: totalPages,
      });
      return;
    }

    // Interactive mode: TTY + table format (--page sets initial page)
    const isInteractive = !!(process.stdout.isTTY && format !== 'text');

    if (isInteractive) {
      const { allModelsWithQuota } = await withSpinner(
        'Fetching models',
        async () => {
          const result = await client.listModels(listOpts);
          const allModels = result.models;
          const allModelsWithQuota =
            allModels.length > 0 ? await client.fetchQuotasForModels(allModels) : allModels;
          return { allModelsWithQuota };
        },
        format,
      );

      if (allModelsWithQuota.length === 0) {
        console.log('No models found matching the specified filters.');
        return;
      }

      const loadPage = async (pageNum: number): Promise<Record<string, string>[]> => {
        const start = (pageNum - 1) * perPage;
        const pageModels = allModelsWithQuota.slice(start, start + perPage);

        // getModels fetches both model details and quota in one call
        const details = await client.getModels(pageModels.map((m: any) => m.id));

        // ModelDetail extends Model, includes free_tier.quota for direct row building
        const modelsWithQuota = pageModels.map((m: any, i: number) => details[i] ?? m);

        return buildModelRows(modelsWithQuota, details);
      };

      const totalPages = Math.ceil(allModelsWithQuota.length / perPage);
      if (page > totalPages && totalPages > 0) {
        process.stderr.write(
          `Warning: Requested page ${page} exceeds total pages (${totalPages}), starting from last page.\n`,
        );
      }

      // Pre-load first page data so initial render shows content immediately without loading state
      const initialRows = await loadPage(page);

      await renderInteractive(
        React.createElement(InteractiveTable, {
          columns: MODEL_LIST_COLUMNS,
          totalItems: allModelsWithQuota.length,
          perPage,
          loadPage,
          initialPage: page,
          initialRows,
          title: 'Models',
        }),
      );
      return;
    }

    // Non-interactive: static pagination for table/text modes
    const { allModelsWithQuota: allFetchedModels } = await withSpinner(
      'Fetching models',
      async () => {
        const result = await client.listModels(listOpts);
        const allModels = result.models;
        const allModelsWithQuota =
          allModels.length > 0 ? await client.fetchQuotasForModels(allModels) : allModels;
        return { allModelsWithQuota };
      },
      format,
    );

    if (allFetchedModels.length === 0) {
      console.log('No models found matching the specified filters.');
      return;
    }

    const totalModels = allFetchedModels.length;
    const totalPages = Math.ceil(totalModels / perPage);

    if (page > totalPages && totalPages > 0) {
      process.stderr.write(
        `Warning: Requested page ${page} exceeds total pages (${totalPages}). No results to display.\n`,
      );
    }

    const startIndex = (page - 1) * perPage;
    const endIndex = startIndex + perPage;
    const pageModels = allFetchedModels.slice(startIndex, endIndex);

    // getModels reads quota from cache, no additional API requests needed
    const details = await client.getModels(pageModels.map((m: any) => m.id));

    // Build UI data for consistent rendering (includes color metadata)
    const modelsWithQuota = pageModels.map((m: any, i: number) => details[i] ?? m);
    const uiData = buildModelsUiData(modelsWithQuota, details);

    if (format === 'text') {
      renderTextModelsList(uiData);
    } else {
      // Table mode (Ink) — enhanced rendering with Section
      await renderModelsTableInk(uiData, {
        title: 'Models',
        footer: `${totalModels} models  ·  Page ${page} of ${totalPages}`,
      });
    }

    // Pagination footer (for all non-JSON modes)
    printPaginationFooter(page, totalPages, totalModels);
  } catch (error) {
    handleError(error, format);
  }
}

/**
 * Enrich a list of Models with their full detail (features, context,
 * rate_limits, description, tags, metadata). Used for `--verbose` JSON mode.
 * `getModels` reads from the cached raw API data, so this is cheap.
 */
async function enrichWithDetails(
  client: Awaited<ReturnType<typeof createClient>>,
  models: any[],
): Promise<any[]> {
  const details = await client.getModels(models.map((m) => m.id));
  return models.map((m, i) => details[i] ?? m);
}
