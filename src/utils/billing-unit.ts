import type { Model } from '../types/model.js';

export type BillingUnit = 'tokens' | 'images' | 'characters' | 'seconds';

const VALID_UNITS: ReadonlySet<string> = new Set(['tokens', 'images', 'characters', 'seconds']);

/**
 * Infer the billing unit (= what the API charges by) for a model.
 *
 * Signals, in priority order:
 *   1. `free_tier.quota.unit` — server-authoritative
 *   2. Pricing-shape discriminator (`per_image`, `per_second`, `per_character`, `tiers`)
 *   3. `modality.output` heuristic
 *
 * Used to pick the correct breakdown table headers (Tokens / Images / Duration /
 * Characters) so a video or image model never gets shown with "Tokens (in/out)".
 */
export function inferBillingUnitFromModel(model: Model): BillingUnit {
  const quotaUnit = model.free_tier?.quota?.unit;
  if (quotaUnit && VALID_UNITS.has(quotaUnit)) {
    return quotaUnit as BillingUnit;
  }

  const pricing = model.pricing as Record<string, unknown> | undefined;
  if (pricing) {
    if (pricing.per_image) return 'images';
    if (pricing.per_second) return 'seconds';
    if (pricing.per_second_audio) return 'seconds';
    if (pricing.per_character) return 'characters';
    if (pricing.tiers || pricing.per_token) return 'tokens';
  }

  const out = model.modality?.output ?? [];
  if (out.includes('image')) return 'images';
  if (out.includes('video')) return 'seconds';
  if (out.includes('audio')) return 'seconds';
  return 'tokens';
}
