/**
 * `usage logs` — paginated call-log query.
 *
 * Resolves the time range, dispatches to UsageService via the CliFacade, then
 * fans out to the three rendering modes (TUI / TEXT / JSON). Filter flags
 * (`--model`, `--status`) are repeatable; `--request-id` short-circuits the
 * other filters to mimic the upstream exact-match contract.
 */

import React from 'react';
import type { Command } from 'commander';
import { createClient } from '../../api/client.js';
import type { UsageLogsOptions } from '../../api/client.js';
import type { UsageLogStatusType } from '../../services/usage-service.js';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { resolveDateRange, formatDate } from '../../utils/date.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { buildUsageLogsViewModel } from '../../view-models/usage-logs.js';
import { renderUsageLogsInk, buildUsageLogRows, USAGE_LOG_COLUMNS } from '../../ui/UsageLogs.js';
import { InteractiveTable } from '../../ui/InteractiveTable.js';
import { renderInteractive } from '../../ui/render.js';
import { renderTextUsageLogs } from '../../output/text/usage.js';
import { handleError, CliError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_RANGE_DAYS = 14;

/**
 * Maps user-facing status aliases (case-insensitive) onto the canonical
 * upstream enum values. Lookup happens after `toLowerCase()`, so all keys
 * here are lowercase.
 */
const STATUS_ALIAS_MAP: Record<string, UsageLogStatusType> = {
  '0': 'CANCEL',
  cancel: 'CANCEL',
  canceled: 'CANCEL',
  '2xx': 'SUCCESS',
  '200': 'SUCCESS',
  success: 'SUCCESS',
  '4xx': 'CLIENT_ERROR',
  'client-error': 'CLIENT_ERROR',
  client_error: 'CLIENT_ERROR',
  '5xx': 'SERVER_ERROR',
  'server-error': 'SERVER_ERROR',
  server_error: 'SERVER_ERROR',
};

export function collectRepeatable(value: string, previous: string[] | undefined): string[] {
  return previous ? [...previous, value] : [value];
}

/** Logs-specific time range: hour/day presets fall back to resolveDateRange
 *  for week/month-style values used by the rest of the CLI. */
function resolveLogsTimeRange(opts: { from?: string; to?: string; period?: string }): {
  from: string;
  to: string;
} {
  if (opts.from || opts.to) {
    const from = opts.from;
    const to = opts.to;
    if (!from && to) {
      const toDate = new Date(to + 'T00:00:00');
      toDate.setDate(toDate.getDate() - 7);
      return resolveDateRange({ from: formatDate(toDate), to });
    }
    return resolveDateRange({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }
  const period = opts.period;
  if (period) {
    const m = /^(\d+)([hd])$/.exec(period);
    if (m) {
      const n = parseInt(m[1], 10);
      const ms = m[2] === 'h' ? n * 3600 * 1000 : n * 86400 * 1000;
      const now = new Date();
      return {
        from: new Date(now.getTime() - ms).toISOString(),
        to: now.toISOString(),
      };
    }
    if (period === 'today') {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: startOfDay.toISOString(), to: now.toISOString() };
    }
    if (period === 'yesterday') {
      const now = new Date();
      const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: startOfYesterday.toISOString(), to: endOfYesterday.toISOString() };
    }
    return resolveDateRange({ period });
  }
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  return {
    from: sevenDaysAgo.toISOString(),
    to: now.toISOString(),
  };
}

export function usageLogsAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    try {
      const fromOpt = typeof options.from === 'string' ? options.from : undefined;
      const toOpt = typeof options.to === 'string' ? options.to : undefined;
      const periodOpt = typeof options.period === 'string' ? options.period : undefined;
      let dateRange: { from: string; to: string };
      try {
        dateRange = resolveLogsTimeRange({
          ...(fromOpt ? { from: fromOpt } : {}),
          ...(toOpt ? { to: toOpt } : {}),
          ...(periodOpt ? { period: periodOpt } : {}),
        });
      } catch (err) {
        throw new CliError({
          code: 'INVALID_ARGUMENT',
          message: err instanceof Error ? err.message : String(err),
          exitCode: EXIT_CODES.INVALID_ARGUMENT,
        });
      }

      const fromMs = new Date(dateRange.from).getTime();
      const toMs = new Date(dateRange.to).getTime();
      const diffDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);
      if (diffDays > MAX_RANGE_DAYS) {
        throw new CliError({
          code: 'INVALID_ARGUMENT',
          message: 'Time range cannot be longer than 14 days.',
          exitCode: EXIT_CODES.INVALID_ARGUMENT,
        });
      }

      const models = Array.isArray(options.model) ? (options.model as string[]) : undefined;
      const statusRaw = Array.isArray(options.status) ? (options.status as string[]) : undefined;
      const statusCodeTypes = statusRaw
        ? statusRaw
            .map((s) => STATUS_ALIAS_MAP[s.toLowerCase()])
            .filter((s): s is UsageLogStatusType => Boolean(s))
        : undefined;
      const modelRequestId =
        typeof options.requestId === 'string' && options.requestId.length > 0
          ? options.requestId
          : undefined;
      const page = clampPage(options.page);
      const pageSize = clampPageSize(options.pageSize);

      await ensureAuthenticated();
      const client = await createClient();

      const callOpts: UsageLogsOptions = {
        from: dateRange.from,
        to: dateRange.to,
        page,
        pageSize,
      };
      if (models && models.length > 0) callOpts.models = models;
      if (statusCodeTypes && statusCodeTypes.length > 0) {
        callOpts.statusCodeTypes = statusCodeTypes;
      }
      if (modelRequestId) callOpts.modelRequestId = modelRequestId;

      const data = await withSpinner(
        'Fetching usage logs',
        () => client.getUsageLogs(callOpts),
        format,
      );

      if (format === 'json') {
        outputJSON(data);
        return;
      }

      const vm = buildUsageLogsViewModel(data);

      if (format === 'text') {
        renderTextUsageLogs(vm);
        return;
      }

      // Interactive paginated table when stdout is a real TTY. Falls back to
      // the static Ink renderer for piped/redirected output and for empty
      // result sets, where there is nothing to page through.
      const isInteractive = !!(process.stdout.isTTY && format === 'table');
      if (isInteractive && !vm.isEmpty) {
        const loadPage = async (pageNum: number): Promise<Record<string, string>[]> => {
          const pageData = await client.getUsageLogs({ ...callOpts, page: pageNum });
          const pageVm = buildUsageLogsViewModel(pageData);
          return buildUsageLogRows(pageVm.items);
        };

        const initialRows = buildUsageLogRows(vm.items);
        const subtitle = vm.periodLabel || undefined;

        const tableProps: {
          columns: typeof USAGE_LOG_COLUMNS;
          totalItems: number;
          perPage: number;
          loadPage: typeof loadPage;
          initialPage: number;
          initialRows: Record<string, string>[];
          title: string;
          subtitle?: string;
        } = {
          columns: USAGE_LOG_COLUMNS,
          totalItems: vm.totalCount,
          perPage: pageSize,
          loadPage,
          initialPage: page,
          initialRows,
          title: 'Usage Logs',
        };
        if (subtitle) tableProps.subtitle = subtitle;

        await renderInteractive(React.createElement(InteractiveTable, tableProps));
        return;
      }

      await renderUsageLogsInk(vm);
    } catch (error) {
      handleError(error, format);
    }
  };
}

function clampPage(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_PAGE;
}

function clampPageSize(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(n));
}

export const USAGE_LOGS_DEFAULTS = {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
