/**
 * Model adapter — pure transformations from raw API model responses to Service-layer DTOs.
 */
import type { ApiModelGroup, ApiModelItem } from '../../types/api-models.js';
import type { Model, ModelDetail, ModelsListResponse } from '../../types/model.js';
import {
  flattenApiModels,
  mapApiModelToModel,
  mapApiModelToModelDetail,
} from '../model-mapper/index.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/**
 * Entry shape of the CDN-hosted model-mapping JSON. Extra fields are kept
 * verbatim so downstream consumers can extend the schema without coordination
 * with the adapter.
 */
export interface ModelMappingEntry {
  snapshot?: string;
  deprecated?: boolean;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────
// List transformation
// ────────────────────────────────────────────────────────────────────

/**
 * Flatten groups, then map each item to the trimmed list-view shape. Free-tier
 * info defaults to absent — list callers who need quotas attach them later via
 * the dedicated quota-fetch path.
 */
export function transformModelList(groups: ApiModelGroup[]): ModelsListResponse {
  const items = flattenApiModels(groups);
  const models: Model[] = items.map((item) => mapApiModelToModel(item, false));
  return { models, total: models.length };
}

// ────────────────────────────────────────────────────────────────────
// Detail transformation
// ────────────────────────────────────────────────────────────────────

/**
 * Map a single ApiModelItem to a ModelDetail. The base mapper truncates the
 * UpdateAt timestamp to a YYYY-MM-DD prefix for list-view display; the
 * adapter overrides this so callers receive the original ISO 8601 string.
 */
export function transformModelDetail(item: ApiModelItem): ModelDetail {
  const base = mapApiModelToModelDetail(item, false);
  return {
    ...base,
    metadata: {
      ...base.metadata,
      updated: item.UpdateAt ?? '',
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Mapping transformation
// ────────────────────────────────────────────────────────────────────

/**
 * Pass-through transformer for the CDN-hosted model-mapping document. Returns
 * a shallow clone so callers can freely mutate either side without leaking
 * state across requests.
 */
export function transformModelMapping(
  raw: Record<string, ModelMappingEntry>,
): Record<string, ModelMappingEntry> {
  const out: Record<string, ModelMappingEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = { ...value };
  }
  return out;
}
