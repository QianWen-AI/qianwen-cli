import type {
  AnalysisGranularity,
  BreakdownGroupBy,
  ChargeType,
} from '../../types/billing-extra.js';

const VALID_GROUP_BY: BreakdownGroupBy[] = ['model', 'api-key'];
const CHARGE_TYPE_MAP: Record<string, ChargeType> = {
  subscription: 'prepaid',
  payg: 'postpaid',
  all: 'all',
};
const VALID_GRANULARITY: AnalysisGranularity[] = ['day', 'month'];

export function parseGroupBy(raw: unknown, fallback: BreakdownGroupBy = 'model'): BreakdownGroupBy {
  if (typeof raw === 'string' && (VALID_GROUP_BY as string[]).includes(raw)) {
    return raw as BreakdownGroupBy;
  }
  return fallback;
}

export function parseChargeType(raw: unknown, fallback: ChargeType = 'all'): ChargeType {
  if (typeof raw === 'string' && raw in CHARGE_TYPE_MAP) {
    return CHARGE_TYPE_MAP[raw];
  }
  return fallback;
}

export function parseGranularity(
  raw: unknown,
  fallback: AnalysisGranularity = 'day',
): AnalysisGranularity {
  if (typeof raw === 'string' && (VALID_GRANULARITY as string[]).includes(raw)) {
    return raw as AnalysisGranularity;
  }
  return fallback;
}

export function defaultMonthRange(): { from: string; to: string } {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return { from: `${yyyy}-${mm}-01`, to: formatYMD(now) };
}

export function defaultLast7Days(): { from: string; to: string } {
  const now = new Date();
  const to = formatYMD(now);
  const past = new Date(now);
  past.setDate(past.getDate() - 6);
  return { from: formatYMD(past), to };
}

export function defaultLast12Months(): { from: string; to: string } {
  const now = new Date();
  const to = formatYMD(now);
  const past = new Date(now);
  past.setMonth(past.getMonth() - 11);
  past.setDate(1);
  return { from: formatYMD(past), to };
}

export function defaultCurrentMonthCycle(): { from: string; to: string } {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return { from: ym, to: ym };
}

export function clampTop(raw: unknown, fallback = 10): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(100, Math.trunc(n));
}

export function asStringArray(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter((s) => s.length > 0);
  if (typeof raw === 'string' && raw.length > 0) return [raw];
  return [];
}

function formatYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
