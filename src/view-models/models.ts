import type { Model, ModelsListResponse, ModelDetail, Pricing } from '../types/model.js';
import { humanizeNumber, humanizeWithUnit } from '../output/humanize.js';
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
  if (isFreeOnly) return 'Free';

  if ('tiers' in pricing) {
    const tiers = pricing.tiers;
    if (tiers.length === 0) return '\u2014';
    if (tiers.every((t) => t.input === 0 && t.output === 0)) return 'Free';

    const paid = tiers.filter((t) => t.input > 0 || t.output > 0);
    if (paid.length === 0) return 'Free';

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
    const freeTierRemainingPct = model.free_tier.quota
      ? model.free_tier.quota.status === 'expire'
        ? 0
        : Math.round((100 - model.free_tier.quota.used_pct) * 10) / 10
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
  pricingType: 'llm' | 'video' | 'image' | 'tts' | 'asr' | 'embedding';
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
    const pct = Math.round((100 - q.used_pct) * 10) / 10;
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
): 'llm' | 'video' | 'image' | 'tts' | 'asr' | 'embedding' {
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
    // LLM pricing table
    const hasCache = pricing.tiers.some((t) => t.cache_creation != null);
    return pricing.tiers.map((tier) => {
      const cells: Record<string, string> = {
        label: tier.label,
        input: `${CUR}${tier.input.toFixed(2)}/1M`,
        output: `${CUR}${tier.output.toFixed(2)}/1M`,
      };
      if (hasCache) {
        cells.cacheCreation =
          tier.cache_creation != null ? `${CUR}${tier.cache_creation.toFixed(2)}/1M` : '—';
        cells.cacheRead = tier.cache_read != null ? `${CUR}${tier.cache_read.toFixed(2)}/1M` : '—';
      }
      return { cells };
    });
  }

  if ('per_second' in pricing) {
    return pricing.per_second.map((p) => ({
      cells: {
        resolution: p.resolution,
        price: `${CUR}${p.price.toFixed(2)} / second`,
      },
    }));
  }

  if ('per_image' in pricing) {
    return [
      {
        cells: {
          label: 'Image Generation',
          price: `${CUR}${pricing.per_image.price.toFixed(2)} / image`,
        },
      },
    ];
  }

  if ('per_character' in pricing) {
    return [
      {
        cells: {
          label: 'TTS',
          price: `${CUR}${pricing.per_character.price.toFixed(2)} / 10,000 characters`,
        },
      },
    ];
  }

  if ('per_second_audio' in pricing) {
    return [
      {
        cells: {
          label: 'ASR',
          price: `${CUR}${pricing.per_second_audio.price.toFixed(5)} / second`,
        },
      },
    ];
  }

  if ('per_token' in pricing) {
    return [
      {
        cells: {
          label: 'Embedding',
          price: `${CUR}${pricing.per_token.price.toFixed(2)} / 1M tokens`,
        },
      },
    ];
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
    const price = tool.price === 0 ? 'Free' : `${CUR}${tool.price.toFixed(2)} / ${unitRaw}`;
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
