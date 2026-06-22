import type {
  SubscriptionOrder,
  SubscriptionOrders,
  SubscriptionDiagnostic,
} from '../../types/subscription.js';
import { CURRENCY_SYMBOL, NA, type ViewContext } from './shared.js';
import { formatAmount } from '../../output/humanize.js';

export type OrderStatusColor = 'green' | 'orange' | 'gray';

export interface SubscriptionOrderRowViewModel {
  orderId: string;
  /** Lowercase canonical order type. */
  orderType: string;
  orderTypeLabel: string;
  orderTime: string;
  amountDisplay: string;
  amountRaw: string;
  /** @deprecated alias for amountDisplay. */
  amount: string;
  currency: string;
  status: string;
  statusLabel: string;
  statusColor: OrderStatusColor;
  detailError: string | null;
}

export interface SubscriptionOrdersColumn {
  key: keyof Pick<
    SubscriptionOrderRowViewModel,
    'orderId' | 'orderTypeLabel' | 'orderTime' | 'amountDisplay' | 'statusLabel'
  >;
  header: string;
}

export interface SubscriptionOrdersPaginationViewModel {
  page: number;
  pageSize: number;
  total: number;
}

export interface SubscriptionOrdersViewModel {
  rows: SubscriptionOrderRowViewModel[];
  columns: SubscriptionOrdersColumn[];
  pagination: SubscriptionOrdersPaginationViewModel;
  diagnostics: SubscriptionDiagnostic[];
  isEmpty: boolean;
  emptyPlaceholder: string;
  pagingNote: string;
  summaryLine: string;
  /** @deprecated kept for legacy renderers; prefer `pagination.page`. */
  page: number;
  /** @deprecated kept for legacy renderers; prefer `pagination.pageSize`. */
  pageSize: number;
  /** @deprecated kept for legacy renderers; prefer `pagination.total`. */
  totalCount: number;
}

export const TYPE_LABEL: Record<string, string> = {
  buy: 'Purchase',
  purchase: 'Purchase',
  renew: 'Renew',
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  remedy: 'Remedy',
  canceled: 'Canceled',
  refund: 'Refund',
  ri_modification: 'RI Modification',
  resize: 'Resize',
  convert: 'Convert',
  exchange: 'Exchange',
  temp_upgrade: 'Temp Upgrade',
  unknown: '—',
};

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PAID: 'Paid',
  UNPAID: 'Unpaid',
  CANCELED: 'Canceled',
};

export const ORDER_STATUS_COLOR: Record<string, OrderStatusColor> = {
  PAID: 'green',
  UNPAID: 'orange',
  CANCELED: 'gray',
};

const COLUMNS: SubscriptionOrdersColumn[] = [
  { key: 'orderId', header: 'Order ID' },
  { key: 'orderTypeLabel', header: 'Type' },
  { key: 'orderTime', header: 'Time' },
  { key: 'amountDisplay', header: 'Amount' },
  { key: 'statusLabel', header: 'Status' },
];

export function buildSubscriptionOrdersViewModel(
  data: SubscriptionOrders,
  diagnostics: SubscriptionDiagnostic[] = [],
  _ctx?: ViewContext,
): SubscriptionOrdersViewModel {
  const rows = data.orders.map(toRow);
  const { page, pageSize, total } = data.pagination;
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const pagingNote =
    total === 0 ? 'No orders' : `Page ${page} • Showing ${start}–${end} of ${total}`;

  return {
    rows,
    columns: COLUMNS,
    pagination: { page, pageSize, total },
    diagnostics,
    isEmpty: rows.length === 0,
    emptyPlaceholder: 'No orders',
    pagingNote,
    summaryLine: pagingNote,
    page,
    pageSize,
    totalCount: total,
  };
}

function toRow(order: SubscriptionOrder): SubscriptionOrderRowViewModel {
  const amountRaw = order.amount;
  const n = Number(amountRaw);
  const amountDisplay = Number.isFinite(n) ? `${CURRENCY_SYMBOL}${formatAmount(n)}` : NA;
  const lcType = (order.orderType ?? '').toLowerCase();
  const rawStatus = (order.status ?? '').toUpperCase();
  return {
    orderId: order.orderId || NA,
    orderType: lcType || 'unknown',
    orderTypeLabel: TYPE_LABEL[lcType] ?? order.orderType ?? NA,
    orderTime: order.orderTime || NA,
    amountDisplay,
    amountRaw,
    amount: amountDisplay,
    currency: order.currency ?? '',
    status: order.status || NA,
    statusLabel: ORDER_STATUS_LABEL[rawStatus] ?? order.status ?? NA,
    statusColor: ORDER_STATUS_COLOR[rawStatus] ?? 'gray',
    detailError: order.detailError ?? null,
  };
}
