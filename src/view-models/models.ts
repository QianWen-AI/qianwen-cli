import type { Model, ModelsListResponse, ModelDetail, Pricing } from '../types/model.js';
import { humanizeNumber, humanizeWithUnit, formatAmount } from '../output/humanize.js';
import { abbreviateModality } from '../utils/modality.js';
import { splitPrice } from '../utils/formatting.js';
import { site } from '../site.js';

/** Currency symbol resolved from site config. */
const CUR = site.features.currency === 'CNY' ? '¥' : '$';

// ── Formatting utilities (model-specific, migrated from utils/formatting.ts) ─

// Unit abbreviation map (mirrors humanize.ts unitAbbrev)
const UNIT_SHORT: Record<string, string> = {
  tokens: 'tok',
  images: 'img',
  characters: 'char',
  seconds: 'sec',
  token: 'tok',
  image: 'img',
  piece: 'img',
  pieces: 'img',
  character: 'char',
  second: 'sec',
  // Chinese units (pass-through)
  '个': '个',
};

/**
 * Format the Free Tier column as split amount + unit for aligned table display.
 */
export function formatFreeTierSplit(model: Model): {
  amount: string;
  unit: string;
  expired?: boolean;
} {
  if (model.free_tier.mode === 'only') return { amount: 'Only', unit: '' };
  if (model.free_tier.mode === 'standard' && model.free_tier.quota) {
    const quota = model.free_tier.quota;
    // Expired quotas show numbers with (expired) suffix, rendered muted by display layer
    if (quota.status === 'expire') {
      return {
        amount: humanizeNumber(quota.total),
        unit: `${UNIT_SHORT[quota.unit] ?? quota.unit} (expired)`,
        expired: true,
      };
    }
    return {
      amount: humanizeNumber(quota.total),
      unit: UNIT_SHORT[quota.unit] ?? quota.unit,
    };
  }
  if (model.free_tier.mode === 'standard') return { amount: '—', unit: '' };
  return { amount: '—', unit: '' };
}

/**
 * Format the Free Tier column value for a model.
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
 */
export function formatPriceFromPricing(pricing: Pricing, isFreeOnly: boolean): string {
  const DASH = '\u2014';
  const isValidNum = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);

  if (isFreeOnly) return 'Free';

  if ('tiers' in pricing) {
    const tiers = pricing.tiers;
    if (!Array.isArray(tiers) || tiers.length === 0) return DASH;

    // Only tiers with numeric, finite input/output are considered understandable.
    const valid = tiers.filter((t) => isValidNum(t?.input) && isValidNum(t?.output));
    if (valid.length === 0) return DASH;

    const paid = valid.filter((t) => t.input > 0 || t.output > 0);
    // All-zero or no paid tier → treat as "no price data" rather than "Free",
    // since only `free_tier.mode === 'only'` carries reliable free-only semantics.
    if (paid.length === 0) return DASH;

    const cheapest = paid.reduce((min, t) => (t.input < min.input ? t : min), paid[0]);
    const suffix = paid.length > 1 ? ' +' : '';
    return `${CUR}${formatAmount(cheapest.input)} / ${CUR}${formatAmount(cheapest.output)}${suffix} /1M tok`;
  }

  if ('per_second' in pricing) {
    const rows = Array.isArray(pricing.per_second) ? pricing.per_second : [];
    const prices = rows.map((r) => r?.price).filter(isValidNum);
    if (prices.length === 0) return DASH;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min === max) return `${CUR}${formatAmount(min)} /sec`;
    return `${CUR}${formatAmount(min)}-${formatAmount(max)} /sec`;
  }

  if ('per_image_tiers' in pricing && pricing.per_image_tiers && pricing.per_image_tiers!.length > 0) {
    const tiers = pricing.per_image_tiers!;
    const prices = tiers.map((t) => t.price).filter(isValidNum);
    if (prices.length === 0) return DASH;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min === max) return `${CUR}${formatAmount(min)} /img`;
    return `${CUR}${formatAmount(min)}-${formatAmount(max)} /img`;
  }

  if ('per_image' in pricing) {
    const p = pricing.per_image?.price;
    if (!isValidNum(p)) return DASH;
    return `${CUR}${formatAmount(p)} /img`;
  }

  if ('per_character' in pricing) {
    const p = pricing.per_character?.price;
    if (!isValidNum(p)) return DASH;
    return `${CUR}${formatAmount(p)} /10K char`;
  }

  if ('per_second_audio' in pricing) {
    const p = pricing.per_second_audio?.price;
    if (!isValidNum(p)) return DASH;
    return `${CUR}${formatAmount(p)} /sec`;
  }

  if ('per_token' in pricing) {
    const p = pricing.per_token?.price;
    if (!isValidNum(p)) return DASH;
    return `${CUR}${formatAmount(p)} /1M tok`;
  }

  if ('items' in pricing && pricing.items.length > 0) {
    const prices = pricing.items.map((i) => i.price).filter(isValidNum);
    if (prices.length === 0) return DASH;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min === max) return `${CUR}${formatAmount(min)}`;
    return `${CUR}${formatAmount(min)}-${formatAmount(max)}`;
  }

  return DASH;
}

// ── Model List ViewModel ──────────────────────────────────────────────

export interface ModelRowViewModel {
  id: string;
  modalityInput: string; // "Text+Img+Video"
  modalityOutput: string; // "Text"
  canTry: string; // "Yes" / "No"
  freeTierAmt: string; // "1M" / "500K" / "Only" / "—"
  freeTierUnit: string; // "tok" | "img" | "sec" | ""
  freeTierRemainingPct?: number; // 0–100, undefined if no quota data
  freeTierExpired?: boolean; // true when quota status is 'expire'
  price: string; // "¥0.50-2.00" (amount only)
  priceUnit: string; // "/1M tok" | "/img" | "/sec" | ""
}

export interface ModelsListViewModel {
  rows: ModelRowViewModel[];
  total: number;
}

/**
 * Build list view model from API response.
 */
export function buildModelListViewModel(response: ModelsListResponse): ModelsListViewModel {
  return buildModelListViewModelFromModels(response.models);
}

/**
 * Build list view model from raw Model[] with optional detail overrides.
 * Used by list/search commands where details come from getModels() cache.
 */
export function buildModelListViewModelFromModels(
  models: Model[],
  details?: (ModelDetail | null)[],
): ModelsListViewModel {
  const rows = models.map((model, i) => {
    const detail = details?.[i] ?? null;
    const pricing = detail?.pricing ?? model.pricing;
    const priceStr = pricing
      ? formatPriceFromPricing(pricing, model.free_tier.mode === 'only')
      : '—';

    const { amount: priceAmt, unit: priceUnit } = splitPrice(priceStr);
    const { amount: ftAmt, unit: ftUnit, expired: ftExpired } = formatFreeTierSplit(model);
    const quota = model.free_tier.quota;
    const freeTierRemainingPct = quota
      ? quota.status === 'expire'
        ? 0
        : quota.total > 0
          ? parseFloat(((quota.remaining / quota.total) * 100).toFixed(2))
          : undefined
      : undefined;
    return {
      id: model.id,
      modalityInput: model.modality.input.map(abbreviateModality).join('+'),
      modalityOutput: model.modality.output.map(abbreviateModality).join('+'),
      canTry: model.can_try ? 'Yes' : 'No',
      freeTierAmt: ftAmt,
      freeTierUnit: ftUnit,
      freeTierRemainingPct,
      freeTierExpired: ftExpired,
      price: priceAmt,
      priceUnit,
    };
  });

  return { rows, total: models.length };
}

// ── Model Detail ViewModel ────────────────────────────────────────────

export interface ModelDetailViewModel {
  // Header
  id: string;
  description: string;
  tags: string; // comma-separated for display

  // Modality
  modalityInput: string; // "Image  Text  Video"
  modalityOutput: string; // "Text"

  // Features
  features: string; // comma-separated or "—"

  // Pricing (rendered lines)
  pricingType: 'llm' | 'video' | 'image' | 'tts' | 'asr' | 'embedding' | 'itemized' | 'no_pricing';
  pricingLines: PricingLineViewModel[];
  builtInTools: BuiltInToolViewModel[];

  // Context (LLM only)
  context?: ContextViewModel;

  // Rate Limits
  rateLimits: string; // "RPM   15K          TPM   5M"

  // Free Tier
  freeTier?: FreeTierSummaryViewModel;

  // Metadata
  metadata: {
    category?: string;
    version: string;
    snapshot?: string;
    openSource: string;
    updated: string;
  };
}

export interface PricingLineViewModel {
  cells: Record<string, string>;
}

export interface BuiltInToolViewModel {
  name: string;
  price: string;
  api: string;
}

export interface ContextViewModel {
  window: string;
  maxInput: string;
  maxOutput: string;
}

export interface FreeTierSummaryViewModel {
  mode: 'standard' | 'only';
  total?: string; // "1M tok" — standard mode with quota
  remaining?: string; // "997.1K tok" — standard mode with quota
  remainingPct?: number; // 99.7
  resetDate?: string; // "2025-06-01" — current cycle end date
  statusLabel?: string; // "(exhaust)" | "(expired)" — non-valid quota status
}

export function buildModelDetailViewModel(detail: ModelDetail): ModelDetailViewModel {
  const pricingType = inferPricingType(detail);
  const pricingLines = buildPricingLines(detail.pricing);

  const vm: ModelDetailViewModel = {
    id: detail.id,
    description: detail.description,
    tags: detail.tags.length > 0 ? detail.tags.join(' · ') : '—',
    modalityInput: detail.modality.input.map(abbreviateModality).join(' · '),
    modalityOutput: detail.modality.output.map(abbreviateModality).join(' · '),
    features: detail.features.length > 0 ? detail.features.join(' · ') : '—',
    pricingType,
    pricingLines,
    builtInTools: buildBuiltInTools(detail.pricing),
    rateLimits: formatRateLimits(detail.rate_limits),
    metadata: {
      category: detail.metadata.category,
      version: detail.metadata.version_tag,
      snapshot: detail.metadata.snapshot,
      openSource: detail.metadata.open_source ? 'Yes' : 'No',
      updated: detail.metadata.updated,
    },
  };

  // Context (LLM only)
  if (detail.context) {
    vm.context = {
      window: humanizeWithUnit(detail.context.context_window, 'tokens'),
      maxInput:
        detail.context.max_input != null
          ? humanizeWithUnit(detail.context.max_input, 'tokens')
          : '—',
      maxOutput:
        detail.context.max_output != null
          ? humanizeWithUnit(detail.context.max_output, 'tokens')
          : '—',
    };
  }

  // Free Tier summary
  if (detail.free_tier.mode === 'standard' && detail.free_tier.quota) {
    const q = detail.free_tier.quota;
    const pct = q.total > 0 ? parseFloat(((q.remaining / q.total) * 100).toFixed(2)) : undefined;
    const statusLabel =
      q.status === 'exhaust' ? '(exhaust)' : q.status === 'expire' ? '(expired)' : undefined;
    vm.freeTier = {
      mode: 'standard',
      total: humanizeWithUnit(q.total, q.unit),
      remaining: humanizeWithUnit(q.remaining, q.unit),
      remainingPct: q.status === 'expire' ? 0 : pct,
      // Display layer wants a compact YYYY-MM-DD; the JSON layer keeps the
      // full ISO timestamp from FreeTierQuota.
      resetDate: q.resetDate ? q.resetDate.slice(0, 10) : undefined,
      statusLabel,
    };
  } else if (detail.free_tier.mode === 'standard') {
    vm.freeTier = { mode: 'standard' };
  } else if (detail.free_tier.mode === 'only') {
    vm.freeTier = { mode: 'only' };
  }

  return vm;
}

// ── Helper Functions ──────────────────────────────────────────────────

function inferPricingType(
  detail: ModelDetail,
): 'llm' | 'video' | 'image' | 'tts' | 'asr' | 'embedding' | 'itemized' | 'no_pricing' {
  const pricing = detail.pricing;
  if (!pricing) return 'llm';

  // Prefer billing_type from pricing summary — 100% accurate for most types
  const billingType = pricing.summary?.billing_type;
  if (billingType) {
    switch (billingType) {
      case 'token':
        // per_token structure = embedding/rerank; tiers structure = LLM
        return 'per_token' in pricing ? 'embedding' : 'llm';
      case 'image':
        return 'image';
      case 'character':
        return 'tts';
      case 'itemized':
        return 'itemized';
      case 'second':
        // Distinguish ASR (per_second_audio) from video (per_second)
        if ('per_second_audio' in pricing) return 'asr';
        return 'video';
      case 'no_pricing':
        // No pricing data available — render as uniform placeholder
        return 'no_pricing';
      // 'free', 'unknown' — fall through to structural inference
    }
  }

  // Fallback: pricing structure detection
  if ('items' in pricing) return 'itemized';
  if ('per_token' in pricing) return 'embedding';
  if ('per_character' in pricing) return 'tts';
  if ('per_second' in pricing) return 'video';
  if ('per_second_audio' in pricing) return 'asr';
  if ('per_image' in pricing) return 'image';
  if ('per_image_tiers' in pricing) return 'image';

  // Fallback: modality-based inference for tiers-based pricing
  // (LLM models all use { tiers: [...] })
  const { input, output } = detail.modality;
  const hasContext = !!detail.context;

  if (output.includes('text') && hasContext) return 'llm';
  if (output.includes('video')) return 'video';
  if (output.includes('image')) return 'image';
  if (input.length === 1 && input[0] === 'text' && output.includes('audio')) return 'tts';
  if (input.includes('audio') && output.length === 1 && output[0] === 'text') return 'asr';
  if (output.includes('vector')) return 'embedding';

  // Default to LLM if output includes text
  if (output.includes('text')) return 'llm';
  return 'llm';
}

function buildPricingLines(pricing: Pricing): PricingLineViewModel[] {
  if ('tiers' in pricing) {
    // Empty tiers means the mapper could not interpret the upstream pricing
    // shape (e.g. non-token MultiPrices). Surface a single em-dash row so the
    // Pricing card retains its tabular structure without falsely advertising
    // a free or zero price.
    if (pricing.tiers.length === 0) {
      return [{ cells: { label: '\u2014', input: '\u2014', output: '\u2014' } }];
    }

    // LLM pricing table
    const hasCache = pricing.tiers.some((t) => t.cache_creation != null);
    return pricing.tiers.map((tier) => {
      const cells: Record<string, string> = {
        label: tier.label,
        input: `${CUR}${formatAmount(tier.input)}/1M`,
        output: `${CUR}${formatAmount(tier.output)}/1M`,
      };
      if (hasCache) {
        cells.cacheCreation =
          tier.cache_creation != null ? `${CUR}${formatAmount(tier.cache_creation)}/1M` : '—';
        cells.cacheRead = tier.cache_read != null ? `${CUR}${formatAmount(tier.cache_read)}/1M` : '—';
      }
      return { cells };
    });
  }

  if ('per_second' in pricing) {
    return pricing.per_second.map((p) => ({
      cells: {
        resolution: p.resolution,
        price: `${CUR}${formatAmount(p.price)} / second`,
      },
    }));
  }

  if ('per_image_tiers' in pricing && pricing.per_image_tiers && pricing.per_image_tiers.length > 0) {
    return pricing.per_image_tiers.map((t) => ({
      cells: {
        label: t.label,
        price: `${CUR}${formatAmount(t.price)} / image`,
      },
    }));
  }

  if ('per_image' in pricing) {
    return [
      {
        cells: {
          label: 'Image Generation',
          price: `${CUR}${formatAmount(pricing.per_image.price)} / image`,
        },
      },
    ];
  }

  if ('per_character' in pricing) {
    return [
      {
        cells: {
          label: 'TTS',
          price: `${CUR}${formatAmount(pricing.per_character.price)} / 10,000 characters`,
        },
      },
    ];
  }

  if ('per_second_audio' in pricing) {
    return [
      {
        cells: {
          label: 'ASR',
          price: `${CUR}${formatAmount(pricing.per_second_audio.price)} / second`,
        },
      },
    ];
  }

  if ('per_token' in pricing) {
    return [
      {
        cells: {
          label: 'Embedding',
          price: `${CUR}${formatAmount(pricing.per_token.price)} / 1M tokens`,
        },
      },
    ];
  }

  if ('items' in pricing && pricing.items.length > 0) {
    return pricing.items.map((item) => ({
      cells: {
        label: item.name,
        price: `${CUR}${formatAmount(item.price)} / ${item.unit}`,
      },
    }));
  }

  return [];
}

function buildBuiltInTools(pricing: Pricing): BuiltInToolViewModel[] {
  if (!('built_in_tools' in pricing) || !pricing.built_in_tools) return [];

  return pricing.built_in_tools.map((tool) => {
    const unitRaw = tool.unit
      .replace(/^(USD|CNY)\//, '')
      .replace(/^per\s+/i, '')
      .trim();
    const price = tool.price === 0 ? 'Free' : `${CUR}${formatAmount(tool.price)} / ${unitRaw}`;
    return { name: tool.name, price, api: tool.api };
  });
}

function formatRateLimits(rl: {
  rpm: number;
  tpm?: number;
  concurrency?: number;
  async_queue?: number;
}): string {
  const parts = [`RPM   ${humanizeNumber(rl.rpm)}`];
  if (rl.tpm != null) parts.push(`TPM   ${humanizeNumber(rl.tpm)}`);
  if (rl.concurrency != null) parts.push(`Concurrency   ${rl.concurrency}`);
  if (rl.async_queue != null) parts.push(`Async Queue   ${humanizeNumber(rl.async_queue)} tasks`);
  return parts.join('          ');
}
