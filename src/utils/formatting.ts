import type { Model, Pricing } from '../types/model.js';
import { humanizeWithUnit, humanizeNumber } from '../output/humanize.js';
import { site } from '../site.js';

/** Currency symbol resolved from site config. */
const CUR = site.features.currency === 'CNY' ? '¥' : '$';

/**
 * Split a price string like "¥0.50-2.00 /1M tok" into amount and unit.
 * Amount: "¥0.50-2.00"  Unit: "/1M tok"
 * For "Free" or "—" the unit is empty.
 */
export function splitPrice(price: string): { amount: string; unit: string } {
  // Use lastIndexOf so "$0.10 / $0.40 /1M tok" splits at the trailing unit, not the in/out separator
  const idx = price.lastIndexOf(' /');
  if (idx === -1) return { amount: price, unit: '' };
  return { amount: price.slice(0, idx), unit: price.slice(idx + 1) };
}

// Unit abbreviation map (mirrors humanize.ts unitAbbrev)
const UNIT_SHORT: Record<string, string> = {
  tokens: 'tok',
  images: 'img',
  characters: 'char',
  seconds: 'sec',
  // fallback for raw ShowUnit lowercase values that slip through SHOW_UNIT_MAP
  token: 'tok',
  image: 'img',
  piece: 'img',
  pieces: 'img',
  character: 'char',
  second: 'sec',
  // TTS/ASR word-based units
  word: 'char',
  words: 'char',
  'tenthousand word': 'char',
  'tenthousand words': 'char',
  '10k word': 'char',
  '10k words': 'char',
  // Chinese units (pass-through, no abbreviation)
  '个': '个',
};

function abbrevUnit(unit: string): string {
  return UNIT_SHORT[unit] ?? UNIT_SHORT[unit.toLowerCase()] ?? unit;
}

/**
 * Format the Free Tier column as split amount + unit for aligned table display.
 */
export function formatFreeTierSplit(model: Model): { amount: string; unit: string } {
  if (model.free_tier.mode === 'only') return { amount: 'Only', unit: '' };
  if (model.free_tier.mode === 'standard' && model.free_tier.quota) {
    const quota = model.free_tier.quota;
    // Expired quotas should not show specific numbers in models list
    if (quota.status === 'expire') return { amount: 'Expired', unit: '' };
    return {
      amount: humanizeNumber(quota.total),
      unit: abbrevUnit(quota.unit),
    };
  }
  if (model.free_tier.mode === 'standard') return { amount: '—', unit: '' };
  return { amount: '—', unit: '' };
}

/**
 * Format the Free Tier column value for a model.
 * Pure formatting utility — used by both ViewModel and commands layers.
 */
export function formatFreeTier(model: Model): string {
  if (model.free_tier.mode === 'only') return 'Only';
  if (model.free_tier.mode === 'standard' && model.free_tier.quota) {
    const quota = model.free_tier.quota;
    const base = humanizeWithUnit(quota.remaining, quota.unit);
    if (quota.status === 'exhaust') {
      return `${base} (exhaust)`;
    }
    if (quota.status === 'expire') {
      return `${base} (expired)`;
    }
    return base;
  }
  if (model.free_tier.mode === 'standard') return 'Yes';
  return '\u2014';
}

/**
 * Format price column from a Pricing object.
 * Pure formatting utility — used by both ViewModel and commands layers.
 */
export function formatPriceFromPricing(pricing: Pricing, isFreeOnly: boolean): string {
  if (isFreeOnly) return 'Free';

  if ('tiers' in pricing) {
    const tiers = pricing.tiers;
    if (tiers.length === 0) return '\u2014';
    if (tiers.every((t) => t.input === 0 && t.output === 0)) return 'Free';

    const paid = tiers.filter((t) => t.input > 0 || t.output > 0);
    if (paid.length === 0) return 'Free';

    // Show cheapest tier (lowest input price) as representative; "+" flags multi-tier
    const cheapest = paid.reduce((min, t) => (t.input < min.input ? t : min), paid[0]);
    const suffix = paid.length > 1 ? ' +' : '';
    return `${CUR}${cheapest.input.toFixed(2)} / ${CUR}${cheapest.output.toFixed(2)}${suffix} /1M tok`;
  }

  if ('per_second' in pricing) {
    const prices = pricing.per_second.map((r) => r.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min === max) return `${CUR}${min.toFixed(2)} /sec`;
    return `${CUR}${min.toFixed(2)}-${max.toFixed(2)} /sec`;
  }

  if ('per_image' in pricing) {
    return `${CUR}${pricing.per_image.price.toFixed(2)} /img`;
  }

  if ('per_character' in pricing) {
    return `${CUR}${pricing.per_character.price.toFixed(2)} /10K char`;
  }

  if ('per_second_audio' in pricing) {
    return `${CUR}${pricing.per_second_audio.price.toFixed(5)} /sec`;
  }

  if ('per_token' in pricing) {
    return `${CUR}${pricing.per_token.price.toFixed(2)} /1M tok`;
  }

  return '\u2014';
}
