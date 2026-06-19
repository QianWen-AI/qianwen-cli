// Top-level model mapping: assembles the public Model / ModelDetail records
// by combining attribute mapping, pricing mapping, built-in tools and
// free-tier metadata. Also exposes the flatten helper for paginated groups.

import type { ApiModelItem } from '../../types/api-models.js';
import type { Model, ModelDetail, FreeTierQuota, LLMPricing, Context } from '../../types/model.js';
import { mapModality, mapRateLimits, mapBuiltInTools } from './attributes.js';
import { mapPrices } from './pricing-mapper.js';
import { attachPricingSummary } from './pricing-summary.js';

/** Convert the API's ModelItem to the public Model (list item). */
export function mapApiModelToModel(
  apiItem: ApiModelItem,
  hasFreeTier: boolean,
  quota?: FreeTierQuota | null,
): Model {
  // features + context come straight from the same ApiModelItem the detail
  // mapper uses, so including them here costs nothing and saves Agents an
  // extra `models info` round-trip per candidate when filtering by capability.
  const hasTextModality =
    (apiItem.InferenceMetadata?.RequestModality ?? []).includes('Text') ||
    (apiItem.InferenceMetadata?.ResponseModality ?? []).includes('Text');
  const modelInfo = apiItem.ModelInfo;
  const context: Context | undefined =
    hasTextModality && modelInfo && modelInfo.ContextWindow > 0
      ? {
          context_window: modelInfo.ContextWindow,
          ...(modelInfo.MaxInputTokens ? { max_input: modelInfo.MaxInputTokens } : {}),
          ...(modelInfo.MaxOutputTokens ? { max_output: modelInfo.MaxOutputTokens } : {}),
        }
      : undefined;

  return {
    id: apiItem.Model,
    modality: {
      input: mapModality(apiItem.InferenceMetadata?.RequestModality ?? []),
      output: mapModality(apiItem.InferenceMetadata?.ResponseModality ?? []),
    },
    can_try: apiItem.Supports?.Experience ?? false,
    free_tier: {
      mode: apiItem.FreeTierOnly ? 'only' : hasFreeTier ? 'standard' : null,
      quota: quota || null,
    },
    pricing: attachPricingSummary(mapPrices(apiItem.Prices, apiItem.MultiPrices)),
    ...(apiItem.Features && apiItem.Features.length > 0 ? { features: apiItem.Features } : {}),
    ...(context ? { context } : {}),
  };
}

/** Convert the API's ModelItem to ModelDetail. */
export function mapApiModelToModelDetail(
  apiItem: ApiModelItem,
  hasFreeTier: boolean,
  quota?: FreeTierQuota | null,
): ModelDetail {
  const pricing = mapPrices(apiItem.Prices, apiItem.MultiPrices);
  const builtInTools = mapBuiltInTools(apiItem.BuiltInToolMultiPrices);

  // Attach tool information to the LLM pricing
  if ('tiers' in pricing && builtInTools) {
    (pricing as Omit<LLMPricing, 'summary'>).built_in_tools = builtInTools;
  }
  const pricingWithSummary = attachPricingSummary(pricing);

  // Build Context (only for LLM models)
  const hasTextModality =
    (apiItem.InferenceMetadata?.RequestModality ?? []).includes('Text') ||
    (apiItem.InferenceMetadata?.ResponseModality ?? []).includes('Text');

  const modelInfo = apiItem.ModelInfo;
  const context: Context | undefined =
    hasTextModality && modelInfo && modelInfo.ContextWindow > 0
      ? {
          context_window: modelInfo.ContextWindow,
          ...(modelInfo.MaxInputTokens ? { max_input: modelInfo.MaxInputTokens } : {}),
          ...(modelInfo.MaxOutputTokens ? { max_output: modelInfo.MaxOutputTokens } : {}),
        }
      : undefined;

  return {
    id: apiItem.Model,
    description: apiItem.Description,
    tags: (apiItem.Tags?.length ?? 0) > 0 ? apiItem.Tags! : (apiItem.Capabilities ?? []),
    modality: {
      input: mapModality(apiItem.InferenceMetadata?.RequestModality ?? []),
      output: mapModality(apiItem.InferenceMetadata?.ResponseModality ?? []),
    },
    features: apiItem.Features,
    pricing: pricingWithSummary,
    context,
    rate_limits: mapRateLimits(apiItem.QpmInfo),
    can_try: apiItem.Supports?.Experience ?? false,
    free_tier: {
      mode: apiItem.FreeTierOnly ? 'only' : hasFreeTier ? 'standard' : null,
      quota: quota || null,
    },
    metadata: {
      version_tag: apiItem.VersionTag,
      open_source: apiItem.OpenSource,
      updated: (apiItem.UpdateAt ?? '').split('T')[0] || '',
      category: apiItem.Category || undefined,
      snapshot: apiItem.EquivalentSnapshot || undefined,
    },
  };
}

/**
 * Flatten the API response: extract all models from Groups[].Items[].
 */
export function flattenApiModels(groups: Array<{ Items: ApiModelItem[] }>): ApiModelItem[] {
  return groups.flatMap((group) => group.Items);
}
