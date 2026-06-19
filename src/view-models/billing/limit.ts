import type { UsageLimit } from '../../types/billing-extra.js';
import { CURRENCY_CODE, formatMoney, NA, type ViewContext } from './shared.js';

export interface BillingLimitFieldViewModel {
  label: string;
  value: string;
}

export interface BillingLimitViewModel {
  fields: BillingLimitFieldViewModel[];
  currency: string;
  statusRaw: UsageLimit['status'];
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  normal: 'Active',
  exceeded: 'Exceeded',
  warning: 'Warning',
  unknown: 'Unknown',
};

function formatAlertThreshold(raw: string): string {
  if (raw == null) return NA;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return NA;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return NA;
  return `${trimmed}%`;
}

export function buildBillingLimitViewModel(
  data: UsageLimit,
  ctx: ViewContext,
): BillingLimitViewModel {
  const statusLabel = STATUS_LABEL[data.status] ?? data.status ?? 'Unknown';
  const fields: BillingLimitFieldViewModel[] = [
    { label: 'Status', value: statusLabel },
    { label: 'Limit', value: formatMoney(data.limitAmount, ctx) },
    { label: 'Alert threshold', value: formatAlertThreshold(data.alertThreshold) },
  ];
  return {
    fields,
    currency: ctx.currency || CURRENCY_CODE,
    statusRaw: data.status,
  };
}
