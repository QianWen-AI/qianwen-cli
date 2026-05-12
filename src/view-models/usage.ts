import type {
  UsageSummaryResponse,
  UsageBreakdownResponse,
  FreeTierUsage,
  TokenPlan,
  PayAsYouGo,
  UsageBreakdownRow,
} from '../types/usage.js';
import { humanizeNumber, humanizeWithUnit } from '../output/humanize.js';
import { site } from '../site.js';

/** Currency symbol resolved from site config. */
const CUR = site.features.currency === 'CNY' ? '¥' : '$';

// ── Usage Summary ViewModel ───────────────────────────────────────────

export interface UsageSummaryViewModel {
  period: string; // "2026-04-07"
  freeTier?: FreeTierSectionViewModel;
  tokenPlan?: TokenPlanSectionViewModel;
  payAsYouGo?: PayAsYouGoSectionViewModel;
}

export interface FreeTierSectionViewModel {
  rows: FreeTierRowViewModel[]; // already sorted, possibly truncated
  totalCount: number; // total number of free tier models
  hiddenCount: number; // number hidden due to truncation (0 = no truncation)
  footer: string;
}

export interface FreeTierRowViewModel {
  modelId: string;
  remaining: string; // "850K tok"
  total: string; // "1M tok"
  progressBar: {
    percentage: number; // 0-100
    mode: 'remaining';
    label: string; // "85% left"
  };
  isFreeOnly: boolean; // for "Only" models
}

export interface TokenPlanSectionViewModel {
  planName: string; // "Token Plan 团队版（月）"
  status: string; // "valid" | "exhaust" | "invalid"
  usageDisplay: string; // "0 / 25,000 Credits"
  progressBar: {
    percentage: number; // remaining percentage 0-100
    mode: 'remaining';
    label: string; // "100%"
  };
  resetDate: string; // "2026-06-01" or "—"
  addonRemaining?: string; // "1,000 Credits"
}

export interface PayAsYouGoSectionViewModel {
  period: string; // "2026-04-01 → 2026-04-07"
  rows: PayAsYouGoRowViewModel[]; // sorted by cost desc, possibly truncated
  totalCount: number; // total number of PAYG models
  hiddenCount: number; // hidden due to truncation
  total: {
    requests: string;
    cost: string;
  };
  isEmpty: boolean;
}

export interface PayAsYouGoRowViewModel {
  modelId: string;
  requests: string; // "—" (not available from API)
  usage: string; // "480K in · 120K out tok" or "45 img"
  cost: string; // "¥0.38"
}

export function buildUsageSummaryViewModel(response: UsageSummaryResponse): UsageSummaryViewModel {
  const vm: UsageSummaryViewModel = {
    period: response.period.to,
  };

  // Free Tier section
  if (response.free_tier.length > 0) {
    const allRows = sortFreeTierRows(response.free_tier.map(buildFreeTierRow));
    const totalCount = allRows.length;
    vm.freeTier = {
      rows: allRows,
      totalCount,
      hiddenCount: 0,
      footer: `${totalCount} models with free tier`,
    };
  }

  // Token Plan section
  if (response.token_plan.subscribed) {
    vm.tokenPlan = buildTokenPlanSection(response.token_plan);
  }

  // Pay-as-you-go section
  vm.payAsYouGo = buildPayAsYouGoSection(response.pay_as_you_go, response.period);

  return vm;
}

/**
 * Sort free tier rows by urgency: quota models first (ascending remaining%),
 * then quota=null models at the end.
 */
function sortFreeTierRows(rows: FreeTierRowViewModel[]): FreeTierRowViewModel[] {
  return [...rows].sort((a, b) => {
    const aHasQuota = !a.isFreeOnly;
    const bHasQuota = !b.isFreeOnly;
    if (aHasQuota && bHasQuota) {
      return a.progressBar.percentage - b.progressBar.percentage; // lower remaining% first
    }
    if (aHasQuota) return -1;
    if (bHasQuota) return 1;
    return a.modelId.localeCompare(b.modelId);
  });
}

function buildFreeTierRow(usage: FreeTierUsage): FreeTierRowViewModel {
  if (usage.quota == null) {
    // "Only" mode or no quota
    return {
      modelId: usage.model_id,
      remaining: '—',
      total: '—',
      progressBar: { percentage: 100, mode: 'remaining', label: '' },
      isFreeOnly: true,
    };
  }

  const q = usage.quota;
  const remainingPct = Math.round((100 - q.used_pct) * 10) / 10; // round to 1dp

  // Expired quota: show total with (expired) suffix, not misleading remaining amount
  const remainingStr =
    q.status === 'expire'
      ? `${humanizeWithUnit(q.total, q.unit)} (expired)`
      : humanizeWithUnit(q.remaining, q.unit);

  return {
    modelId: usage.model_id,
    remaining: remainingStr,
    total: humanizeWithUnit(q.total, q.unit),
    progressBar: {
      percentage: q.status === 'expire' ? 0 : remainingPct,
      mode: 'remaining',
      label: q.status === 'expire' ? 'expired' : `${remainingPct}%`,
    },
    isFreeOnly: false,
  };
}

function buildTokenPlanSection(tokenPlan: TokenPlan): TokenPlanSectionViewModel {
  const total = tokenPlan.totalCredits ?? 0;
  const remaining = tokenPlan.remainingCredits ?? 0;
  const usedPct = tokenPlan.usedPct ?? 0;
  const remainingPct = Math.round((100 - usedPct) * 10) / 10;

  const resetDate = tokenPlan.resetDate
    ? tokenPlan.resetDate.split('T')[0] // ISO → YYYY-MM-DD
    : '—';

  const displayStatus = tokenPlan.status ?? '—';

  return {
    planName: tokenPlan.planName ?? 'Token Plan',
    status: displayStatus,
    usageDisplay: `${humanizeNumber(remaining)} / ${humanizeNumber(total)} Credits`,
    progressBar: {
      percentage: tokenPlan.status === 'exhaust' ? 0 : remainingPct,
      mode: 'remaining',
      label: tokenPlan.status === 'exhaust' ? '0%' : `${remainingPct}%`,
    },
    resetDate,
    addonRemaining: tokenPlan.addonRemaining
      ? `${humanizeNumber(tokenPlan.addonRemaining)} Credits`
      : undefined,
  };
}

function buildPayAsYouGoSection(
  payg: PayAsYouGo,
  period: { from: string; to: string },
): PayAsYouGoSectionViewModel {
  const isEmpty = payg.models.length === 0;

  // Sort by cost descending (highest spend first)
  const sorted = [...payg.models].sort((a, b) => b.cost - a.cost);
  const totalCount = sorted.length;

  const rows = sorted.map((model) => ({
    modelId: model.model_id,
    requests: '—',
    usage: formatPaygUsage(model),
    cost: `${CUR}${model.cost.toFixed(2)}`,
  }));

  return {
    period: `${period.from} → ${period.to}`,
    rows,
    totalCount,
    hiddenCount: 0,
    total: {
      requests: '—',
      cost: `${CUR}${payg.total.cost.toFixed(2)}`,
    },
    isEmpty,
  };
}

function formatPaygUsage(model: { model_id: string; usage: Record<string, number> }): string {
  const u = model.usage;
  // Tokens: collapse to a single value when the upstream doesn't split in/out
  // (current backend behavior). Auto-expands to "X in · Y out tok" the moment
  // a non-zero tokens_out shows up — keeps parity with the breakdown view.
  if (u.tokens_in != null || u.tokens_out != null) {
    const tokensIn = u.tokens_in ?? 0;
    const tokensOut = u.tokens_out ?? 0;
    if (tokensOut > 0) {
      return `${humanizeNumber(tokensIn)} in · ${humanizeNumber(tokensOut)} out tok`;
    }
    return `${humanizeNumber(tokensIn)} tok`;
  }
  if (u.images != null) {
    return `${humanizeNumber(u.images)} img`;
  }
  if (u.characters != null) {
    return `${humanizeNumber(u.characters)} char`;
  }
  if (u.seconds != null) {
    return `${humanizeNumber(u.seconds)} sec`;
  }
  return '—';
}

// formatNextReset is imported from '../output/humanize.js' — single source of truth

// ── Usage Breakdown ViewModel ─────────────────────────────────────────

export interface UsageBreakdownViewModel {
  title: string; // "Daily Breakdown" / "Monthly Breakdown" / "Quarterly Breakdown"
  modelId: string;
  period: string; // "2026-04-01 → 2026-04-07"
  granularity: 'day' | 'month' | 'quarter';
  subtitle?: string; // "Pay-as-you-go (overflow only)"
  note?: string; // exclusion note
  columns: BreakdownColumn[];
  rows: BreakdownRowViewModel[];
  total: BreakdownTotalViewModel;
  isEmpty: boolean; // true when there are no usage rows in the period
  emptyHint?: string; // friendly empty-state line shown above the table
}

export interface BreakdownColumn {
  key: string;
  header: string;
  align?: 'left' | 'right';
}

export interface BreakdownRowViewModel {
  period: string;
  cells: Record<string, string>;
  isCurrent?: boolean;
}

export interface BreakdownTotalViewModel {
  cells: Record<string, string>;
}

export function buildUsageBreakdownViewModel(
  response: UsageBreakdownResponse,
  options: { billingUnitOverride?: 'tokens' | 'images' | 'characters' | 'seconds' } = {},
): UsageBreakdownViewModel {
  // Prefer caller-provided override (derived from model metadata) so the
  // headers match the model's actual unit even when rows are empty/zero.
  const billingUnit =
    options.billingUnitOverride ??
    (response.rows.length > 0 ? inferBillingUnit(response.rows[0]) : 'tokens');

  // For tokens, the upstream billing API doesn't split input/output — every
  // line item is a single quantity that we currently bucket into tokens_in.
  // Default to a single "Tokens" column; auto-expand to (in / out) only if the
  // data actually carries a non-zero tokens_out anywhere. JSON output is
  // unaffected (always tokens_in / tokens_out), so Agent contracts stay stable.
  const tokensSplit =
    billingUnit === 'tokens' &&
    (response.rows.some((r) => (r.tokens_out ?? 0) > 0) || (response.total.tokens_out ?? 0) > 0);

  const columns = buildBreakdownColumns(billingUnit, { tokensSplit });
  const title = buildBreakdownTitle(response.granularity);

  const rows = response.rows.map((row, _index) => {
    const isCurrent = isRowCurrent(row.period, response.granularity);
    return {
      period: row.period,
      cells: buildBreakdownCells(row, billingUnit, { tokensSplit }),
      isCurrent,
    };
  });

  const totalCells: Record<string, string> = {
    period: 'Total',
    cost: response.total.cost != null ? `${CUR}${response.total.cost.toFixed(2)}` : '—',
  };
  // Populate the unit-specific total cell so the Total row always aligns with
  // the chosen columns. Default to 0 (not "—") for the empty case so a totals
  // row never shows a mix of zeros and dashes.
  const totalUsage = (response.total as any).usage || {};
  switch (billingUnit) {
    case 'tokens':
      if (tokensSplit) {
        totalCells.tokensIn = humanizeNumber(response.total.tokens_in ?? 0);
        totalCells.tokensOut = humanizeNumber(response.total.tokens_out ?? 0);
      } else {
        totalCells.tokens = humanizeNumber(response.total.tokens_in ?? 0);
      }
      break;
    case 'images':
      totalCells.images = humanizeNumber(totalUsage.images ?? 0);
      break;
    case 'characters':
      totalCells.characters = humanizeNumber(totalUsage.characters ?? 0);
      break;
    case 'seconds':
      totalCells.seconds = humanizeNumber(totalUsage.seconds ?? 0);
      break;
  }
  const total = { cells: totalCells };

  const isEmpty = response.rows.length === 0;

  const vm: UsageBreakdownViewModel = {
    title,
    modelId: response.model_id,
    period: `${response.period.from} → ${response.period.to}`,
    granularity: response.granularity,
    columns,
    rows,
    total,
    isEmpty,
  };

  if (isEmpty) {
    vm.emptyHint = 'No usage in this period — try a wider --period.';
  }

  return vm;
}

function inferBillingUnit(row: UsageBreakdownRow): 'tokens' | 'images' | 'characters' | 'seconds' {
  if (row.tokens_in != null || row.tokens_out != null) return 'tokens';
  if (row.usage?.tokens_in != null || row.usage?.tokens_out != null) return 'tokens';
  if (row.usage?.images != null) return 'images';
  if (row.usage?.characters != null) return 'characters';
  if (row.usage?.seconds != null) return 'seconds';
  return 'tokens';
}

function buildBreakdownColumns(
  billingUnit: string,
  opts: { tokensSplit?: boolean } = {},
): BreakdownColumn[] {
  const base: BreakdownColumn[] = [{ key: 'period', header: 'Date', align: 'left' }];

  switch (billingUnit) {
    case 'tokens':
      if (opts.tokensSplit) {
        base.push({ key: 'tokensIn', header: 'Tokens (in)', align: 'right' });
        base.push({ key: 'tokensOut', header: 'Tokens (out)', align: 'right' });
      } else {
        base.push({ key: 'tokens', header: 'Tokens', align: 'right' });
      }
      break;
    case 'images':
      base.push({ key: 'images', header: 'Images', align: 'right' });
      break;
    case 'characters':
      base.push({ key: 'characters', header: 'Characters', align: 'right' });
      break;
    case 'seconds':
      base.push({ key: 'seconds', header: 'Duration (sec)', align: 'right' });
      break;
  }

  base.push({ key: 'cost', header: 'Cost', align: 'right' });
  return base;
}

function buildBreakdownTitle(granularity: 'day' | 'month' | 'quarter'): string {
  switch (granularity) {
    case 'day':
      return 'Daily Breakdown';
    case 'month':
      return 'Monthly Breakdown';
    case 'quarter':
      return 'Quarterly Breakdown';
  }
}

function buildBreakdownCells(
  row: UsageBreakdownRow,
  billingUnit: string,
  opts: { tokensSplit?: boolean } = {},
): Record<string, string> {
  const cells: Record<string, string> = {};

  // Handle both old format (tokens_in/tokens_out at top level) and new format (usage object)
  const usage = row.usage ?? {};

  switch (billingUnit) {
    case 'tokens':
      if (opts.tokensSplit) {
        cells.tokensIn = humanizeNumber(row.tokens_in ?? usage.tokens_in ?? 0);
        cells.tokensOut = humanizeNumber(row.tokens_out ?? usage.tokens_out ?? 0);
      } else {
        // Single-column mode: API doesn't split in/out, so present the total.
        cells.tokens = humanizeNumber(row.tokens_in ?? usage.tokens_in ?? 0);
      }
      break;
    case 'images':
      cells.images = humanizeNumber(usage.images ?? 0);
      break;
    case 'characters':
      cells.characters = humanizeNumber(usage.characters ?? 0);
      break;
    case 'seconds':
      cells.seconds = humanizeNumber(usage.seconds ?? 0);
      break;
  }

  cells.cost = row.cost != null ? `${CUR}${row.cost.toFixed(2)}` : '—';
  return cells;
}

function isRowCurrent(period: string, granularity: 'day' | 'month' | 'quarter'): boolean {
  const today = new Date();
  switch (granularity) {
    case 'day': {
      const todayStr = today.toISOString().slice(0, 10);
      return period === todayStr;
    }
    case 'month': {
      const monthStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      return period === monthStr;
    }
    case 'quarter': {
      const q = Math.floor(today.getMonth() / 3) + 1;
      const quarterStr = `${today.getFullYear()}-Q${q}`;
      return period === quarterStr;
    }
  }
}
