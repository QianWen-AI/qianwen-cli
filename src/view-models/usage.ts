import type {
  UsageSummaryResponse,
  UsageBreakdownResponse,
  FreeTierUsage,
  TokenPlan,
  PayAsYouGo,
  UsageBreakdownRow,
} from '../types/usage.js';
import { humanizeNumber, humanizeWithUnit, formatAmount } from '../output/humanize.js';
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
    cost: string;
  };
  isEmpty: boolean;
}

export interface PayAsYouGoRowViewModel {
  modelId: string;
  usage: string; // "600K tok" or "45 img"
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
  const remainingPct = q.total > 0 ? parseFloat(((q.remaining / q.total) * 100).toFixed(2)) : 0;

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
  const remainingPct = total > 0 ? parseFloat(((remaining / total) * 100).toFixed(2)) : 0;

  const resetDate = tokenPlan.resetDate
    ? tokenPlan.resetDate.split('T')[0] // ISO → YYYY-MM-DD
    : '—';

  const displayStatus = tokenPlan.status ?? '—';

  return {
    planName: tokenPlan.planName ?? 'Token Plan',
    status: displayStatus,
    usageDisplay: `${remaining.toLocaleString()} / ${total.toLocaleString()} Credits`,
    progressBar: {
      percentage: tokenPlan.status === 'exhaust' ? 0 : remainingPct,
      mode: 'remaining',
      label: tokenPlan.status === 'exhaust' ? '0%' : `${remainingPct}%`,
    },
    resetDate,
    addonRemaining: tokenPlan.addonRemaining
      ? `${tokenPlan.addonRemaining.toLocaleString()} Credits`
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
    usage: formatPaygUsage(model),
    cost: `${CUR}${formatAmount(model.cost)}`,
  }));

  return {
    period: `${period.from} → ${period.to}`,
    rows,
    totalCount,
    hiddenCount: 0,
    total: {
      cost: `${CUR}${formatAmount(payg.total.cost)}`,
    },
    isEmpty,
  };
}

function formatPaygUsage(model: { model_id: string; usage: Record<string, number> }): string {
  const u = model.usage;
  // Tokens: the upstream API returns an undifferentiated count with no in/out
  // split; stored under the neutral 'tokens' key by the aggregator.
  if (u.tokens != null) {
    return `${humanizeNumber(u.tokens)} tok`;
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
  if (u.voices != null) {
    return `${humanizeNumber(u.voices)} voice`;
  }
  // Dynamic unit fallback (e.g. "calls", "request") — first non-zero key wins.
  for (const [k, v] of Object.entries(u)) {
    if (typeof v === 'number' && v > 0) {
      return `${humanizeNumber(v)} ${k}`;
    }
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
  options: { billingUnitOverride?: string } = {},
): UsageBreakdownViewModel {
  // Prefer caller-provided override (derived from model metadata) so the
  // headers match the model's actual unit even when rows are empty/zero.
  // The override is only used when it actually matches a unit present in
  // the rows; otherwise we fall back to inference so dynamic units (e.g.
  // "calls") still produce a valid header.
  const inferred = response.rows.length > 0 ? inferBillingUnit(response.rows[0]) : 'tokens';
  const billingUnit = pickBillingUnit(options.billingUnitOverride, inferred, response.rows);

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
    cost: response.total.cost != null ? `${CUR}${formatAmount(response.total.cost)}` : '—',
  };
  // Populate the unit-specific total cell so the Total row always aligns with
  // the chosen columns. Zero values render as "—" (em-dash) uniformly across
  // every unit — text/table modes only. JSON output is unaffected (always raw
  // numbers).
  const totalUsage = (response.total as { usage?: Record<string, number> }).usage ?? {};
  switch (billingUnit) {
    case 'tokens':
      if (tokensSplit) {
        totalCells.tokensIn = formatUsageCell(response.total.tokens_in ?? 0);
        totalCells.tokensOut = formatUsageCell(response.total.tokens_out ?? 0);
      } else {
        totalCells.tokens = formatUsageCell(response.total.tokens_in ?? 0);
      }
      break;
    case 'images':
      totalCells.images = formatUsageCell(totalUsage.images ?? 0);
      break;
    case 'characters':
      totalCells.characters = formatUsageCell(totalUsage.characters ?? 0);
      break;
    case 'seconds':
      totalCells.seconds = formatUsageCell(totalUsage.seconds ?? 0);
      break;
    case 'voices':
      totalCells.voices = formatUsageCell(totalUsage.voices ?? 0);
      break;
    default:
      // Dynamic unit (e.g. "calls", "request") — cell key matches the unit name.
      totalCells[billingUnit] = formatUsageCell(totalUsage[billingUnit] ?? 0);
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

// Known fixed billing units we recognize in the breakdown view. Used by
// `pickBillingUnit` to decide whether a tokens-fallthrough override should be
// preserved or replaced by an inferred dynamic unit.
const FIXED_UNITS = new Set(['tokens', 'images', 'characters', 'seconds', 'voices']);

function pickBillingUnit(
  override: string | undefined,
  inferred: string,
  _rows: UsageBreakdownRow[],
): string {
  if (!override) return inferred;
  // Trust any non-tokens override outright — model metadata (images / characters
  // / seconds / voices) is authoritative even when all rows are zero/empty.
  if (override !== 'tokens') return override;
  // For the tokens default, only honor it when the rows actually carry tokens
  // data, OR no other unit was inferred. This protects dynamic units ("calls",
  // "request") whose model metadata falls through `inferBillingUnitFromModel`
  // to the 'tokens' fallback.
  if (FIXED_UNITS.has(inferred) || inferred === 'tokens') return 'tokens';
  // Inferred is a dynamic unit (not in the fixed set) — prefer it over the
  // fallthrough tokens override so the table headers match row data.
  return inferred;
}

function inferBillingUnit(row: UsageBreakdownRow): string {
  if (row.tokens_in != null || row.tokens_out != null) return 'tokens';
  const usage = row.usage;
  if (!usage) return 'tokens';
  if (usage.tokens_in != null || usage.tokens_out != null) return 'tokens';
  if (usage.images != null) return 'images';
  if (usage.characters != null) return 'characters';
  if (usage.seconds != null) return 'seconds';
  if (usage.voices != null) return 'voices';
  // Dynamic unit fallback — first numeric key wins (deterministic by insertion order).
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === 'number') return k;
  }
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
    case 'voices':
      base.push({ key: 'voices', header: 'Voice', align: 'right' });
      break;
    default: {
      // Dynamic unit — capitalize for the header (e.g. "calls" → "Calls").
      const header = billingUnit.charAt(0).toUpperCase() + billingUnit.slice(1);
      base.push({ key: billingUnit, header, align: 'right' });
      break;
    }
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
        cells.tokensIn = formatUsageCell(row.tokens_in ?? usage.tokens_in ?? 0);
        cells.tokensOut = formatUsageCell(row.tokens_out ?? usage.tokens_out ?? 0);
      } else {
        // Single-column mode: API doesn't split in/out, so present the total.
        cells.tokens = formatUsageCell(row.tokens_in ?? usage.tokens_in ?? 0);
      }
      break;
    case 'images':
      cells.images = formatUsageCell(usage.images ?? 0);
      break;
    case 'characters':
      cells.characters = formatUsageCell(usage.characters ?? 0);
      break;
    case 'seconds':
      cells.seconds = formatUsageCell(usage.seconds ?? 0);
      break;
    case 'voices':
      cells.voices = formatUsageCell(usage.voices ?? 0);
      break;
    default: {
      const dynamicUsage = usage as Record<string, number | undefined>;
      cells[billingUnit] = formatUsageCell(dynamicUsage[billingUnit] ?? 0);
      break;
    }
  }

  cells.cost = row.cost != null ? `${CUR}${formatAmount(row.cost)}` : '—';
  return cells;
}

// Render a usage cell: empty periods (value === 0) show "—" instead of "0" so
// the table visually distinguishes zero-usage rows from rows that actually
// consumed a small amount. Applies uniformly to every billing unit
// (tokens / images / characters / seconds / voice / dynamic). Text and table
// (Ink) modes only — JSON output is unaffected.
function formatUsageCell(value: number): string {
  return value > 0 ? humanizeNumber(value) : '—';
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
