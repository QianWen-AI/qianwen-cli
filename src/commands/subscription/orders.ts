import React from 'react';
import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { withSpinner } from '../../ui/spinner.js';
import { createServices } from '../../services/index.js';
import { buildSubscriptionOrdersViewModel } from '../../view-models/subscription/index.js';
import {
  renderSubscriptionOrdersInk,
  SUBSCRIPTION_ORDERS_COLUMNS,
  buildSubscriptionOrdersRows,
} from '../../ui/SubscriptionOrders.js';
import { renderTextSubscriptionOrders } from '../../output/text/subscription.js';
import { handleError, CliError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import type { OrderType } from '../../types/subscription.js';
import { InteractiveTable } from '../../ui/InteractiveTable.js';
import { renderInteractive } from '../../ui/render.js';
import { site } from '../../site.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const VALID_TYPE: OrderType[] = ['purchase', 'renew', 'upgrade'];
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function invalidArgument(message: string, format: 'json' | 'table' | 'text'): never {
  return handleError(
    new CliError({
      code: 'INVALID_ARGUMENT',
      message,
      exitCode: EXIT_CODES.GENERAL_ERROR,
    }),
    format,
  );
}

function validateDateOption(
  name: '--from' | '--to',
  value: unknown,
  format: 'json' | 'table' | 'text',
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    invalidArgument(`${name} must be a valid date in YYYY-MM-DD format.`, format);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    invalidArgument(`${name} must be a valid date in YYYY-MM-DD format.`, format);
  }
  return value;
}

export function registerSubscriptionOrdersCommand(parent: Command): void {
  const orders = parent
    .command('orders')
    .description('List subscription orders (purchase / renew / upgrade)')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option('--type <kind>', 'Filter by order type: purchase | renew | upgrade')
    .option('--page <n>', 'Page number', (v) => parseInt(v, 10), DEFAULT_PAGE)
    .option(
      '--page-size <n>',
      `Page size (1..${MAX_PAGE_SIZE})`,
      (v) => parseInt(v, 10),
      DEFAULT_PAGE_SIZE,
    )
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');

  orders.action(subscriptionOrdersAction(orders));
}

export function subscriptionOrdersAction(cmd: Command) {
  return async function (this: Command, options: Record<string, unknown>) {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(this ?? cmd, config);

    const page = clamp(options.page, 1, 10_000, DEFAULT_PAGE);
    const requestedPageSize =
      typeof options.pageSize === 'number' ? options.pageSize : Number(options.pageSize);
    if (Number.isFinite(requestedPageSize) && requestedPageSize > MAX_PAGE_SIZE) {
      handleError(
        new CliError({
          code: 'INVALID_ARGUMENT',
          message: `--page-size must not exceed ${MAX_PAGE_SIZE}`,
          exitCode: EXIT_CODES.GENERAL_ERROR,
        }),
        format,
      );
      return;
    }
    const pageSize = clamp(options.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    let type: OrderType | undefined;
    if (options.type !== undefined) {
      if (typeof options.type !== 'string' || !(VALID_TYPE as string[]).includes(options.type)) {
        invalidArgument('--type must be purchase, renew or upgrade.', format);
      }
      type = options.type as OrderType;
    }
    const from = validateDateOption('--from', options.from, format);
    const to = validateDateOption('--to', options.to, format);
    if (from && to && from > to) {
      invalidArgument('--from must be earlier than or equal to --to.', format);
    }
    const commodityCodeList = [
      site.features.tokenPlanCommodityCodes.teams,
      site.features.tokenPlanCommodityCodes.addon,
      site.features.tokenPlanCommodityCodes.soloBuy,
    ]
      .filter(Boolean)
      .join(',');

    try {
      ensureAuthenticated();
      const { subscriptionService } = createServices();
      const result = await withSpinner(
        'Fetching subscription orders',
        () =>
          subscriptionService.listOrders({
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
            ...(type ? { type } : {}),
            page,
            pageSize,
            commodityCodeList,
          }),
        format,
      );

      if (format === 'json') {
        const vm = buildSubscriptionOrdersViewModel(result);
        outputJSON({
          orders: vm.rows.map((item) => ({
            orderId: item.orderId,
            orderType: item.orderTypeLabel,
            orderTime: item.orderTime,
            amount: item.amountDisplay,
            currency: item.currency,
            status: item.statusLabel,
          })),
          pagination: vm.pagination,
          diagnostics: vm.diagnostics,
        });
        return;
      }

      const vm = buildSubscriptionOrdersViewModel(result);
      if (format === 'text') {
        renderTextSubscriptionOrders(vm);
      } else if (process.stdout.isTTY && !vm.isEmpty) {
        const initialRows = buildSubscriptionOrdersRows(vm);
        const loadPage = async (p: number): Promise<Record<string, string>[]> => {
          if (p === page) return initialRows;
          const r = await subscriptionService.listOrders({
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
            ...(type ? { type } : {}),
            page: p,
            pageSize,
            commodityCodeList,
          });
          return buildSubscriptionOrdersRows(buildSubscriptionOrdersViewModel(r));
        };
        await renderInteractive(
          React.createElement(InteractiveTable, {
            columns: SUBSCRIPTION_ORDERS_COLUMNS,
            totalItems: vm.pagination.total,
            perPage: pageSize,
            loadPage,
            initialPage: page,
            initialRows,
            title: 'Subscription Orders',
          }),
        );
      } else {
        await renderSubscriptionOrdersInk(vm);
      }
    } catch (error) {
      handleError(error, format);
    }
  };
}
