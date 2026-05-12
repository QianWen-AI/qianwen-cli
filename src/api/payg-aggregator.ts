/**
 * Pure aggregators for pay-as-you-go billing items.
 *
 * Both `usage summary` and `usage breakdown` get their PAYG numbers from the
 * same upstream endpoint (`MaasListConsumeSummary`). The HTTP fetch + per-item
 * parsing now lives in a single place (`fetchPaygItems` on RealApiClient); these
 * two functions reduce the resulting flat item list along the two views the
 * commands need:
 *
 *   - `aggregatePaygByModel` — summary view (one row per model)
 *   - `aggregatePaygByDate`  — breakdown view (one row per billing date)
 *
 * Keeping them pure makes summary/breakdown reconciliation a unit-test
 * property rather than a manual cross-check.
 */

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
    if (!it.modelId) continue;
    const entry = (dict[it.modelId] ??= { usage: {}, cost: 0 });

    // Tokens collapse into a single tokens_in bucket (the upstream API doesn't
    // split input/output). Other units key by their unit name.
    const key = it.billingUnit === 'tokens' ? 'tokens_in' : it.billingUnit;
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
 * units land flat too (`images` / `seconds` / `characters`) — the consumer
 * (`getUsageBreakdown`) re-shapes them into the response's `usage` nested
 * object. `aggregateMonthly` / `aggregateQuarterly` rely on this flat layout.
 */
export interface PaygDailyRow {
  period: string;
  tokens_in?: number;
  tokens_out?: number;
  images?: number;
  seconds?: number;
  characters?: number;
  cost: number;
  currency: string;
  billingUnit: string;
}

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
      byUnit: { tokens: 0, images: 0, seconds: 0, characters: 0 },
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
