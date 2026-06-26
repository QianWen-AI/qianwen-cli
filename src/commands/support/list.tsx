import React from 'react';
import { resolveFormat } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError, HandledError, invalidArgError } from '../../utils/errors.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { createServices } from '../../services/index.js';
import { withSpinner } from '../../ui/spinner.js';
import { buildSupportListViewModel } from '../../view-models/support/index.js';
import { renderTextSupportList } from '../../output/text/support.js';
import type { Column } from '../../ui/Table.js';
import { InteractiveTable } from '../../ui/InteractiveTable.js';
import { renderInteractive } from '../../ui/render.js';
import { theme } from '../../ui/theme.js';
import type { SupportListItemViewModel } from '../../view-models/support/list.js';

export interface SupportListOptions {
  page?: string;
  pageSize?: string;
  format?: string;
}

const COLUMNS: Column[] = [
  { key: 'id', header: 'Ticket ID', color: (v: string) => theme.data(v) },
  { key: 'title', header: 'Title' },
  { key: 'status', header: 'Status' },
  { key: 'createdAt', header: 'Created' },
];

function toRows(items: SupportListItemViewModel[]): Record<string, string>[] {
  return items.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
  }));
}

const INTEGER_PATTERN = /^[+-]?\d+$/;

function parseStrictInt(raw: unknown): number | null {
  if (typeof raw !== 'string' || !INTEGER_PATTERN.test(raw)) return null;
  return parseInt(raw, 10);
}

export async function supportListAction(options: SupportListOptions): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);

  try {
    ensureAuthenticated();
    const { supportService } = createServices();

    const DEFAULT_PAGE_SIZE = 10;

    const page = Math.max(1, parseInt(options.page || '1', 10) || 1);

    let pageSize = DEFAULT_PAGE_SIZE;
    if (options.pageSize !== undefined) {
      const parsed = parseStrictInt(options.pageSize);
      if (parsed === null || parsed < 1 || parsed > 10) {
        throw invalidArgError('--page-size must be a positive integer between 1 and 10.');
      }
      pageSize = parsed;
    }

    const result = await withSpinner(
      'Loading tickets',
      () => supportService.listTickets({ page, pageSize }),
      format,
    );

    const vm = buildSupportListViewModel(
      result.tickets,
      result.page,
      result.pageSize,
      result.total,
    );

    if (format === 'json') {
      printJSON({
        tickets: result.tickets,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      });
      return;
    }

    if (format === 'text') {
      renderTextSupportList(vm);
      return;
    }

    if (vm.isEmpty) {
      console.log(vm.emptyMessage);
      return;
    }

    if (!process.stdout.isTTY) {
      renderTextSupportList(vm);
      return;
    }

    const initialRows = toRows(vm.tickets);

    const loadPage = async (p: number): Promise<Record<string, string>[]> => {
      if (p === page) return initialRows;
      const r = await supportService.listTickets({ page: p, pageSize });
      const v = buildSupportListViewModel(r.tickets, r.page, r.pageSize, r.total);
      return toRows(v.tickets);
    };

    await renderInteractive(
      React.createElement(InteractiveTable, {
        columns: COLUMNS,
        totalItems: vm.total,
        perPage: pageSize,
        loadPage,
        initialPage: page,
        initialRows,
        title: 'Support Tickets',
      }),
    );
  } catch (error) {
    if (error instanceof HandledError) throw error;
    handleError(error, format);
  }
}
