import type {
  BreakdownGroupBy,
  ConsumeBreakdown,
  ConsumeBreakdownRow,
} from '../../types/billing-extra.js';
import { formatAmount } from '../../output/humanize.js';
import { CURRENCY_CODE, formatMoney, NA, type ViewContext } from './shared.js';

export interface BillingBreakdownCellMap {
  key: string;
  label: string;
  amount: string;
}

export interface BillingBreakdownRowViewModel {
  cells: BillingBreakdownCellMap;
  raw: {
    amount: string;
  };
}

export interface BillingBreakdownColumn {
  key: keyof BillingBreakdownCellMap;
  header: string;
}

export interface BillingBreakdownViewModel {
  groupBy: BreakdownGroupBy;
  period: string;
  chargeType: ConsumeBreakdown['chargeType'];
  columns: BillingBreakdownColumn[];
  rows: BillingBreakdownRowViewModel[];
  total: { amount: string; raw: string; display: string };
  currency: string;
  shown: number;
  totalRows: number;
  truncationNotice: string | null;
}

const GROUP_HEADER: Record<BreakdownGroupBy, string> = {
  model: 'Model',
  'api-key': 'API Key',
};

function isZeroAmount(amount: string): boolean {
  const n = Number(amount);
  return Number.isFinite(n) && n === 0;
}

function formatTotalAmount(amount: string | null | undefined): string {
  if (amount == null) return NA;
  const n = Number(amount);
  if (!Number.isFinite(n)) return NA;
  return formatAmount(n);
}

export function buildBillingBreakdownViewModel(
  data: ConsumeBreakdown,
  ctx: ViewContext,
): BillingBreakdownViewModel {
  const rows = data.rows.map((row) => toRow(row, ctx));
  const shown = rows.length;
  const truncationNotice =
    shown < data.totalRows ? `Showing top ${shown} / ${data.totalRows}` : null;

  const columns: BillingBreakdownColumn[] = [
    { key: 'label', header: GROUP_HEADER[data.groupBy] },
    { key: 'amount', header: 'Amount' },
  ];

  const totalAmount = rows.length === 0 ? NA : formatTotalAmount(data.totalAmount);
  const totalDisplay = rows.length === 0 ? NA : formatMoney(data.totalAmount, ctx);

  return {
    groupBy: data.groupBy,
    period: `${data.period.from} → ${data.period.to}`,
    chargeType: data.chargeType,
    columns,
    rows,
    total: { amount: totalAmount, raw: data.totalAmount, display: totalDisplay },
    currency: ctx.currency || data.currency || CURRENCY_CODE,
    shown,
    totalRows: data.totalRows,
    truncationNotice,
  };
}

function toRow(row: ConsumeBreakdownRow, ctx: ViewContext): BillingBreakdownRowViewModel {
  const isZero = isZeroAmount(row.amount);
  return {
    cells: {
      key: row.groupKey || NA,
      label: row.groupLabel || row.groupKey || NA,
      amount: isZero ? NA : formatMoney(row.amount, ctx),
    },
    raw: {
      amount: row.amount,
    },
  };
}
