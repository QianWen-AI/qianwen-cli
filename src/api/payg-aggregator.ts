/** Pure aggregators for pay-as-you-go billing items. */

import type { PayAsYouGoModel } from '../types/usage.js';
import { site } from '../site.js';

/** A normalized billing item — what the aggregators actually need. */
export interface PaygItem {
  billingDate: string; // YYYY-MM-DD
  billingMonth: string; // YYYY-MM (filled even when only date is known)
  modelId: string;
  usageValue: number; // raw count in the unit's natural scale
  cost: number;
  billingUnit: string; // 'tokens' | 'images' | 'seconds' | 'characters' | ...
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ── Summary view: one row per model ──────────────────────────────────

export interface PaygSummaryAggregate {
  models: PayAsYouGoModel[];
  total: { cost: number; currency: string };
}

export function aggregatePaygByModel(items: PaygItem[]): PaygSummaryAggregate {
  const dict: Record<
    string,
    {
      usage: Record<string, number>;
      cost: number;
    }
  > = {};
  let totalCost = 0;

  for (const it of items) {
    if (!it.modelId) continue; // defensive: upstream guarantees non-empty
    const entry = (dict[it.modelId] ??= { usage: {}, cost: 0 });

    // Tokens aggregate under the neutral 'tokens' key — the upstream API returns
    // a single undifferentiated quantity with no input/output split.
    // Other units key by their unit name.
    const key = it.billingUnit === 'tokens' ? 'tokens' : it.billingUnit;
    entry.usage[key] = (entry.usage[key] ?? 0) + it.usageValue;
    entry.cost += it.cost;
    totalCost += it.cost;
  }

  const models: PayAsYouGoModel[] = Object.entries(dict).map(([modelId, e]) => ({
    model_id: modelId,
    usage: roundUsageCounts(e.usage),
    cost: round4(e.cost),
    currency: site.features.currency,
  }));

  return {
    models,
    total: {
      cost: round4(totalCost),
      currency: site.features.currency,
    },
  };
}

// ── Breakdown view: one row per billing date ─────────────────────────

/**
 * Daily-aggregated row. Tokens stay at top-level (`tokens_in`); non-token
 * units land flat too (`images` / `seconds` / `characters` / `voices`) — the
 * consumer (`getUsageBreakdown`) re-shapes them into the response's `usage`
 * nested object. `aggregateMonthly` / `aggregateQuarterly` rely on this flat
 * layout. `otherUsage` carries dynamic units extracted from unknown
 * "Per X Y" formats (e.g. `{ calls: 2000200 }`).
 */
export interface PaygDailyRow {
  period: string;
  tokens_in?: number;
  tokens_out?: number;
  images?: number;
  seconds?: number;
  characters?: number;
  voices?: number;
  otherUsage?: Record<string, number>;
  cost: number;
  currency: string;
  billingUnit: string;
  // Index signature: required for downstream aggregators that accept `[key: string]: unknown`.
  [key: string]: unknown;
}

const KNOWN_FLAT_UNITS = new Set(['tokens', 'images', 'seconds', 'characters', 'voices']);

export function aggregatePaygByDate(items: PaygItem[]): PaygDailyRow[] {
  const byKey: Record<
    string,
    {
      byUnit: Record<string, number>;
      cost: number;
    }
  > = {};

  for (const it of items) {
    const key = it.billingDate;
    if (!key) continue;
    const bucket = (byKey[key] ??= {
      byUnit: {},
      cost: 0,
    });
    bucket.byUnit[it.billingUnit] = (bucket.byUnit[it.billingUnit] ?? 0) + it.usageValue;
    bucket.cost += it.cost;
  }

  const rows: PaygDailyRow[] = [];
  for (const key of Object.keys(byKey).sort()) {
    const d = byKey[key];
    const unitsPresent = Object.entries(d.byUnit)
      .filter(([, v]) => v > 0)
      .map(([u]) => u);
    // Defensive default: when a single day mixes units, fall back to tokens.
    const billingUnit = unitsPresent.length === 1 ? unitsPresent[0] : 'tokens';

    const row: PaygDailyRow = {
      period: key,
      cost: round4(d.cost),
      currency: site.features.currency,
      billingUnit,
    };
    if (d.byUnit.tokens) row.tokens_in = Math.round(d.byUnit.tokens);
    if (d.byUnit.images) row.images = Math.round(d.byUnit.images);
    if (d.byUnit.seconds) row.seconds = Math.round(d.byUnit.seconds);
    if (d.byUnit.characters) row.characters = Math.round(d.byUnit.characters);
    if (d.byUnit.voices) row.voices = Math.round(d.byUnit.voices);
    // Dynamic units (e.g. "calls", "request") collected via Per-format fallback.
    const other: Record<string, number> = {};
    for (const [u, v] of Object.entries(d.byUnit)) {
      if (!KNOWN_FLAT_UNITS.has(u) && v > 0) other[u] = Math.round(v);
    }
    if (Object.keys(other).length > 0) row.otherUsage = other;
    rows.push(row);
  }

  return rows;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Round all values in a usage record to integers (token/image/etc counts). */
function roundUsageCounts(usage: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) {
    out[k] = Math.round(v);
  }
  return out;
}

/**
 * Fill date gaps so every day in [from, to] has a row, even if the API
 * returned no data for that day.  Missing dates get a zero-value row.
 */
export function fillDailyGaps(rows: PaygDailyRow[], from: string, to: string): PaygDailyRow[] {
  const existing = new Map(rows.map((r) => [r.period, r]));
  const filled: PaygDailyRow[] = [];

  // Walk from `from` to `to` inclusive, one day at a time.
  const cursor = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');

  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    filled.push(
      existing.get(key) ?? {
        period: key,
        tokens_in: 0,
        cost: 0,
        currency: site.features.currency,
        billingUnit: 'tokens',
      },
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return filled;
}

// ── Time-period aggregators ──────────────────────────────────────────

/** Row shape accepted/produced by monthly and quarterly aggregators. */
export interface AggregatedRow {
  period: string;
  tokens_in?: number;
  tokens_out?: number;
  cost: number;
  currency: string;
  billingUnit: string;
  [key: string]: unknown;
}

const KNOWN_KEYS = ['tokens_in', 'tokens_out', 'images', 'seconds', 'characters', 'voices'];

interface AccumulatorBucket {
  tokens_in: number;
  tokens_out: number;
  images: number;
  seconds: number;
  characters: number;
  voices: number;
  other: Record<string, number>;
  cost: number;
  units: Set<string>;
}

function newBucket(): AccumulatorBucket {
  return {
    tokens_in: 0,
    tokens_out: 0,
    images: 0,
    seconds: 0,
    characters: 0,
    voices: 0,
    other: {},
    cost: 0,
    units: new Set(),
  };
}

function accumulateRow(bucket: AccumulatorBucket, row: AggregatedRow): void {
  bucket.cost += row.cost;
  if (row.tokens_in) {
    bucket.tokens_in += row.tokens_in;
    bucket.units.add('tokens');
  }
  const r = row as Record<string, unknown>;
  if (r.tokens_out) {
    bucket.tokens_out += r.tokens_out as number;
    bucket.units.add('tokens');
  }
  if ('images' in r) {
    bucket.images += (r.images as number) ?? 0;
    bucket.units.add('images');
  }
  if ('seconds' in r) {
    bucket.seconds += (r.seconds as number) ?? 0;
    bucket.units.add('seconds');
  }
  if ('characters' in r) {
    bucket.characters += (r.characters as number) ?? 0;
    bucket.units.add('characters');
  }
  if ('voices' in r) {
    bucket.voices += (r.voices as number) ?? 0;
    bucket.units.add('voices');
  }
  // Dynamic units from otherUsage or top-level numeric fields.
  const otherUsage = (r as { otherUsage?: Record<string, number> }).otherUsage;
  if (otherUsage) {
    for (const [k, v] of Object.entries(otherUsage)) {
      if (typeof v !== 'number') continue;
      bucket.other[k] = (bucket.other[k] ?? 0) + v;
      bucket.units.add(k);
    }
  }
  for (const [k, v] of Object.entries(r)) {
    if (KNOWN_KEYS.includes(k)) continue;
    if (k === 'period' || k === 'cost' || k === 'currency' || k === 'billingUnit') continue;
    if (k === 'otherUsage') continue;
    if (typeof v !== 'number') continue;
    bucket.other[k] = (bucket.other[k] ?? 0) + v;
    bucket.units.add(k);
  }
}

function bucketToRow(key: string, bucket: AccumulatorBucket): AggregatedRow {
  const usage: Record<string, number> = {};
  if (bucket.tokens_in) usage['tokens_in'] = bucket.tokens_in;
  if (bucket.tokens_out) usage['tokens_out'] = bucket.tokens_out;
  if (bucket.images) usage['images'] = bucket.images;
  if (bucket.seconds) usage['seconds'] = bucket.seconds;
  if (bucket.characters) usage['characters'] = bucket.characters;
  if (bucket.voices) usage['voices'] = bucket.voices;
  for (const [k, v] of Object.entries(bucket.other)) {
    if (v) usage[k] = v;
  }
  const unitsList = [...bucket.units].sort();
  const billingUnit = unitsList.length === 1 ? unitsList[0] : 'tokens';
  return {
    period: key,
    ...usage,
    cost: round4(bucket.cost),
    currency: site.features.currency,
    billingUnit,
  };
}

/**
 * Aggregate daily rows into monthly rows (client-side).
 * Keeps totals consistent across all granularities.
 */
export function aggregateMonthly(dailyRows: AggregatedRow[]): AggregatedRow[] {
  const byMonth: Record<string, AccumulatorBucket> = {};

  for (const row of dailyRows) {
    const monthKey = row.period.slice(0, 7); // YYYY-MM
    if (!byMonth[monthKey]) byMonth[monthKey] = newBucket();
    accumulateRow(byMonth[monthKey], row);
  }

  return Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => bucketToRow(key, bucket));
}

/**
 * Aggregate monthly rows into quarterly periods (client-side).
 */
export function aggregateQuarterly(monthlyRows: AggregatedRow[]): AggregatedRow[] {
  const byQuarter: Record<string, AccumulatorBucket> = {};

  for (const row of monthlyRows) {
    const monthStr = row.period;
    const year = parseInt(monthStr.slice(0, 4));
    const monthNum = parseInt(monthStr.slice(5, 7));
    const quarter = Math.floor((monthNum - 1) / 3) + 1;
    const quarterKey = `${year}-Q${quarter}`;

    if (!byQuarter[quarterKey]) byQuarter[quarterKey] = newBucket();
    accumulateRow(byQuarter[quarterKey], row);
  }

  return Object.entries(byQuarter)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => bucketToRow(key, bucket));
}
