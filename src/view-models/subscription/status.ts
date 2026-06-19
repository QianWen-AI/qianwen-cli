import type {
  SubscriptionDiagnostic,
  SubscriptionPeriod,
  SubscriptionStatus,
} from '../../types/subscription.js';
import {
  CURRENCY_SYMBOL,
  NA,
  PARTIAL_FAILURE_NOTE_TEMPLATE,
  STATUS_UNAVAILABLE_NOTE,
  formatBool,
  formatPeriod,
  renderQuotaBarFor,
  type ViewContext,
} from './shared.js';
import { buildProgressBar, theme } from '../../ui/theme.js';
import { ORDER_STATUS_COLOR, ORDER_STATUS_LABEL, TYPE_LABEL } from './orders.js';
import type { OrderStatusColor } from './orders.js';

export interface SubscriptionStatusFieldViewModel {
  label: string;
  value: string;
}

export interface SubscriptionStatusSectionViewModel {
  id: string;
  title: string;
  fields: SubscriptionStatusFieldViewModel[];
  placeholder?: string;
}

export interface SubscriptionQuotaViewModel {
  total: number;
  remaining: number;
  usedPct: number;
  bar: string;
  display: string;
}

export interface TokenPlanSectionTierViewModel {
  label: string;
  bar: string;
  remaining: number;
  total: number;
  usedPct: number;
}

export interface TokenPlanSectionViewModel {
  status: string;
  autoRenew: string;
  expires: string;
  tiers: TokenPlanSectionTierViewModel[];
}

export interface CreditPackEntryViewModel {
  id: string;
  remaining: string;
  bar: string;
  expires: string;
}

export interface CreditPackSectionViewModel {
  count: number;
  totalRemaining: string;
  packs: CreditPackEntryViewModel[];
}

export interface RecentOrderEntryViewModel {
  id: string;
  type: string;
  typeLabel: string;
  date: string;
  amount: string;
  statusLabel: string;
  statusColor: OrderStatusColor;
}

export interface RecentOrdersSectionViewModel {
  orders: RecentOrderEntryViewModel[];
}

export interface SubscriptionStatusViewModel {
  available: boolean;
  banner: string | null;
  footnote: string | null;
  fields: SubscriptionStatusFieldViewModel[];
  sections: SubscriptionStatusSectionViewModel[];
  quota: SubscriptionQuotaViewModel | null;
  quotaBar: string | null;
  diagnostics: SubscriptionDiagnostic[];
  tokenPlanSection: TokenPlanSectionViewModel | null;
  creditPackSection: CreditPackSectionViewModel | null;
  recentOrdersSection: RecentOrdersSectionViewModel | null;
  /** @deprecated alias for banner. */
  errorBanner: string | null;
  /** @deprecated alias for footnote. */
  notice: string | null;
}

function buildQuota(
  data: SubscriptionStatus,
  ctx: ViewContext | undefined,
): { quota: SubscriptionQuotaViewModel | null; bar: string | null } {
  if (!data.quota) return { quota: null, bar: null };
  const used = Math.max(0, data.quota.total - data.quota.remaining);
  const { bar } = renderQuotaBarFor(used, data.quota.total, ctx);
  const usedPct = data.quota.usedPct;
  const display =
    data.quota.total > 0
      ? `${data.quota.remaining.toLocaleString('en-US')} / ${data.quota.total.toLocaleString('en-US')} (${usedPct}%)`
      : NA;
  return {
    quota: {
      total: data.quota.total,
      remaining: data.quota.remaining,
      usedPct,
      bar,
      display,
    },
    bar,
  };
}

function capitalize(value: string): string {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatInteger(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function isPeriodActive(period: SubscriptionPeriod | null): boolean | null {
  if (!period || !period.end) return null;
  const end = Date.parse(period.end);
  if (!Number.isFinite(end)) return null;
  return end >= Date.now();
}

function formatExpires(period: SubscriptionPeriod | null, remainingDays: number | null): string {
  if (!period?.end) return NA;
  const datePart = period.end.length >= 10 ? period.end.slice(0, 10) : period.end;
  if (remainingDays === null) return datePart;
  return `${datePart} (${remainingDays}d)`;
}

function buildTokenPlanSection(data: SubscriptionStatus): TokenPlanSectionViewModel | null {
  if (!data.seatTiers || data.seatTiers.length === 0) return null;

  const active = isPeriodActive(data.period);
  const status = active === null ? NA : active ? 'Active' : 'Expired';
  const autoRenew = data.autoRenew === true ? 'On' : data.autoRenew === false ? 'Off' : NA;
  const expires = formatExpires(data.period, data.remainingDays);

  const tiers: TokenPlanSectionTierViewModel[] = data.seatTiers.map((tier) => {
    const remainingPct =
      tier.totalCredits > 0
        ? Math.min(100, Math.max(0, (tier.remainingCredits / tier.totalCredits) * 100))
        : 0;
    const bar = buildProgressBar(remainingPct, 24, theme.data, true);
    const labelType = tier.specType ? capitalize(tier.specType) : 'Tier';
    const seatNoun = tier.seats === 1 ? 'seat' : 'seats';
    const label = `${labelType} (${tier.seats} ${seatNoun})`;
    const remainingStr = formatInteger(tier.remainingCredits);
    const totalStr = formatInteger(tier.totalCredits);
    const decorated = `${bar} ${remainingStr} / ${totalStr}`;
    return {
      label,
      bar: decorated,
      remaining: tier.remainingCredits,
      total: tier.totalCredits,
      usedPct: tier.usedPct,
    };
  });

  return { status, autoRenew, expires, tiers };
}

function buildCreditPackSection(data: SubscriptionStatus): CreditPackSectionViewModel | null {
  if (!data.creditPacks || data.creditPacks.length === 0) return null;
  const totalRemaining = data.creditPacks.reduce((sum, p) => sum + p.remainingCredits, 0);
  const packs: CreditPackEntryViewModel[] = data.creditPacks.map((p) => {
    const pct =
      p.totalCredits > 0
        ? Math.min(100, Math.max(0, (p.remainingCredits / p.totalCredits) * 100))
        : 0;
    const bar = buildProgressBar(pct, 24, theme.data, true);
    return {
      id: p.instanceId || NA,
      remaining: `${formatInteger(p.remainingCredits)} / ${formatInteger(p.totalCredits)}`,
      bar,
      expires: p.expiresAt ? p.expiresAt.slice(0, 10) : NA,
    };
  });
  return {
    count: data.creditPacks.length,
    totalRemaining: `${formatInteger(totalRemaining)} credits`,
    packs,
  };
}

function buildRecentOrdersSection(data: SubscriptionStatus): RecentOrdersSectionViewModel | null {
  if (!data.recentOrders || data.recentOrders.length === 0) return null;
  const orders: RecentOrderEntryViewModel[] = data.recentOrders.map((o) => {
    const date = o.orderTime ? o.orderTime.slice(0, 10) : NA;
    const amountStr = o.amount ?? '';
    const display =
      amountStr && CURRENCY_SYMBOL && !amountStr.startsWith(CURRENCY_SYMBOL)
        ? `${CURRENCY_SYMBOL}${amountStr}`
        : amountStr || NA;
    const lcType = (o.orderType ?? '').toLowerCase();
    const rawStatus = (o.status ?? '').toUpperCase();
    return {
      id: o.orderId || NA,
      type: o.orderType || NA,
      typeLabel: TYPE_LABEL[lcType] ?? o.orderType ?? NA,
      date,
      amount: display,
      statusLabel: ORDER_STATUS_LABEL[rawStatus] ?? o.status ?? NA,
      statusColor: (ORDER_STATUS_COLOR[rawStatus] ?? 'gray') as OrderStatusColor,
    };
  });
  return { orders };
}

export function buildSubscriptionStatusViewModel(
  data: SubscriptionStatus | null,
  diagnostics: SubscriptionDiagnostic[],
  ctx?: ViewContext,
): SubscriptionStatusViewModel {
  if (!data) {
    return {
      available: false,
      banner: STATUS_UNAVAILABLE_NOTE,
      footnote: null,
      fields: [],
      sections: [],
      quota: null,
      quotaBar: null,
      diagnostics,
      tokenPlanSection: null,
      creditPackSection: null,
      recentOrdersSection: null,
      errorBanner: STATUS_UNAVAILABLE_NOTE,
      notice: null,
    };
  }

  const fields: SubscriptionStatusFieldViewModel[] = [
    { label: 'Plan', value: data.plan ?? NA },
    {
      label: 'Period',
      value: data.period ? formatPeriod(data.period.start, data.period.end) : NA,
    },
    { label: 'Auto-Renew', value: formatBool(data.autoRenew) },
    { label: 'Renewable', value: formatBool(data.renewable) },
    { label: 'Gray', value: formatBool(data.isGray) },
  ];

  const { quota, bar: quotaBar } = buildQuota(data, ctx);

  const sections: SubscriptionStatusSectionViewModel[] = [];
  if (quota) {
    sections.push({
      id: 'quota',
      title: 'Quota',
      fields: [
        { label: 'Remaining', value: quota.display },
        { label: 'Bar', value: quota.bar },
      ],
    });
  } else {
    sections.push({
      id: 'quota',
      title: 'Quota',
      fields: [],
      placeholder: 'Quota unavailable',
    });
  }

  const tokenPlanSection = buildTokenPlanSection(data);
  const creditPackSection = buildCreditPackSection(data);
  const recentOrdersSection = buildRecentOrdersSection(data);

  const footnote =
    diagnostics.length > 0 ? PARTIAL_FAILURE_NOTE_TEMPLATE(diagnostics.length) : null;

  return {
    available: true,
    banner: null,
    footnote,
    fields,
    sections,
    quota,
    quotaBar,
    diagnostics,
    tokenPlanSection,
    creditPackSection,
    recentOrdersSection,
    errorBanner: null,
    notice: footnote,
  };
}
