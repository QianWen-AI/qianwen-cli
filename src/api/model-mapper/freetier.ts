// Free-tier quota mapping: converts an API FqInstanceItem (with raw capacity
// numbers + locale-dependent ShowUnit) into the normalised FreeTierQuota shape
// consumed by the usage / models view-models.

import type { FqInstanceItem } from '../../types/api-models.js';
import type { FreeTierQuota } from '../../types/model.js';
import { SHOW_UNIT_MAP, normalizeShowUnit } from './pricing-taxonomy.js';

export function mapFqInstanceToQuota(instance: FqInstanceItem): FreeTierQuota {
  const total = instance.InitCapacity.BaseValue;
  const remaining = instance.CurrCapacity.BaseValue;
  const rawShowUnit = instance.InitCapacity.ShowUnit;
  // Case-insensitive lookup: try exact match first, then title-case, then lowercase
  const unit =
    SHOW_UNIT_MAP[rawShowUnit] ??
    SHOW_UNIT_MAP[rawShowUnit.toLowerCase()] ??
    normalizeShowUnit(rawShowUnit.toLowerCase());
  const used_pct = total > 0 ? Math.floor(((total - remaining) / total) * 10000) / 100 : 0;
  const status = instance.Status as 'valid' | 'exhaust' | 'expire';

  // Normalize CurrentCycleEndTime to a strict ISO 8601 UTC string so Agents
  // can parse with stdlib `Date` / `datetime`. Empty/invalid → null (report 6.4).
  let resetDate: string | null = null;
  if (instance.CurrentCycleEndTime) {
    const d = new Date(instance.CurrentCycleEndTime);
    if (!Number.isNaN(d.getTime())) {
      resetDate = d.toISOString();
    }
  }
  return { remaining, total, unit, used_pct, status, resetDate };
}
