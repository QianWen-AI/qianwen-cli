// ============================================================
// Mapping functions from API to PRD format
// Convert the raw data returned by the backend API into the standard format
// used internally by the CLI.
// ============================================================

import type {
  ApiModelItem,
  ApiPriceItem,
  ApiMultiPriceRange,
  ApiQpmInfo,
  ApiBuiltInToolPrice,
  FqInstanceItem,
} from '../types/api-models.js';
import { addDiagnostic } from './debug-buffer.js';
import type {
  Model,
  ModelDetail,
  ModalityType,
  FreeTierQuota,
  Pricing,
  PricingSummary,
  LLMPricing,
  VideoPerSecondPricing,
  ImagePricing,
  TTSPricing,
  ASRPricing,
  EmbeddingPricing,
  ItemizedPricing,
  PricingTier,
  BuiltInTool,
  Context,
  RateLimits,
  ImageTier,
  PriceItem,
} from '../types/model.js';
import { site } from '../site.js';

/** Currency label used in pricing unit strings (e.g. "CNY/1M tokens" or "USD/1M tokens"). */
const CUR_LABEL = site.features.currency;

/** Parse a price string to a finite number; returns 0 for NaN / non-numeric input. */
function safePrice(raw: string | undefined | null): number {
  if (raw == null) return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Apply a discount multiplier to a base price.
 * Validates that the discount is in the range (0, 1]; invalid or missing
 * discounts return the original price unchanged.
 * Uses toPrecision(10) + parseFloat to clean floating-point noise.
 */
function applyDiscount(basePrice: number, discount: string | undefined | null): number {
  if (discount == null) return basePrice;
  const d = parseFloat(discount);
  if (!Number.isFinite(d) || d <= 0 || d > 1) return basePrice;
  return parseFloat((basePrice * d).toPrecision(10));
}

/**
 * Internal mapper output before `summary` is attached. mapPrices/mapMultiPrices
 * build the raw shape; attachPricingSummary() converts it to the public Pricing
 * type (which requires summary on every variant). Splitting these stages keeps
 * the dozen-or-so internal `return` sites in mapPrices free of summary noise.
 */
type RawPricing =
  | Omit<LLMPricing, 'summary'>
  | Omit<VideoPerSecondPricing, 'summary'>
  | Omit<ImagePricing, 'summary'>
  | Omit<TTSPricing, 'summary'>
  | Omit<ASRPricing, 'summary'>
  | Omit<EmbeddingPricing, 'summary'>
  | Omit<ItemizedPricing, 'summary'>;

function minPositive(values: Array<number | null | undefined>): number {
  let best = Infinity;
  for (const v of values) {
    if (v != null && v > 0 && v < best) best = v;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Compute the normalized PricingSummary for a raw pricing variant. Lets Agents
 * sort/compare across token-billed and unit-billed models without branching on
 * the underlying shape (report 6.3).
 */
function computePricingSummary(p: RawPricing): PricingSummary {
  if ('tiers' in p) {
    if (p.tiers.length === 0) {
      return { cheapest_input: 0, cheapest_output: 0, unit: '', billing_type: 'unknown' };
    }
    if (p.tiers.every((t) => t.input === 0 && t.output === 0)) {
      return { cheapest_input: 0, cheapest_output: 0, unit: p.tiers[0].unit, billing_type: 'free' };
    }
    return {
      cheapest_input: minPositive(p.tiers.map((t) => t.input)),
      cheapest_output: minPositive(p.tiers.map((t) => t.output)),
      unit: p.tiers[0].unit,
      billing_type: 'token',
    };
  }
  if ('per_token' in p) {
    return {
      cheapest_input: p.per_token.price,
      cheapest_output: 0,
      unit: p.per_token.unit,
      billing_type: 'token',
    };
  }
  if ('per_image_tiers' in p && p.per_image_tiers && p.per_image_tiers.length > 0) {
    return {
      cheapest_input: 0,
      cheapest_output: minPositive(p.per_image_tiers.map((t) => t.price)),
      unit: p.per_image_tiers[0].unit,
      billing_type: 'image',
    };
  }
  if ('per_image' in p) {
    return {
      cheapest_input: 0,
      cheapest_output: p.per_image.price,
      unit: p.per_image.unit,
      billing_type: 'image',
    };
  }
  if ('per_character' in p) {
    return {
      cheapest_input: 0,
      cheapest_output: p.per_character.price,
      unit: p.per_character.unit,
      billing_type: 'character',
    };
  }
  if ('per_second_audio' in p) {
    return {
      cheapest_input: p.per_second_audio.price,
      cheapest_output: 0,
      unit: p.per_second_audio.unit,
      billing_type: 'second',
    };
  }
  if ('per_second' in p) {
    return {
      cheapest_input: 0,
      cheapest_output: minPositive(p.per_second.map((s) => s.price)),
      unit: p.per_second[0]?.unit ?? `${CUR_LABEL}/second`,
      billing_type: 'second',
    };
  }
  if ('items' in p && p.items.length > 0) {
    return {
      cheapest_input: 0,
      cheapest_output: minPositive(p.items.map((i) => i.price)),
      unit: p.items[0].unit,
      billing_type: 'itemized',
    };
  }
  return { cheapest_input: 0, cheapest_output: 0, unit: '', billing_type: 'unknown' };
}

function attachPricingSummary(raw: RawPricing): Pricing {
  return { ...raw, summary: computePricingSummary(raw) } as Pricing;
}

// ============================================================
// Price type mapping table
// ============================================================

interface PriceFieldMapping {
  field: 'input' | 'output' | 'cache_creation' | 'cache_read';
  category: 'standard' | 'text_only_input' | 'multimodal_input' | 'cache';
}

const PRICE_TYPE_MAP: Record<string, PriceFieldMapping> = {
  // Standard input types
  input_token: { field: 'input', category: 'standard' },
  text_input_token: { field: 'input', category: 'standard' },
  thinking_input_token: { field: 'input', category: 'standard' },
  thinking_text_input_token: { field: 'input', category: 'standard' },

  // Multimodal input
  vision_input_token: { field: 'input', category: 'standard' },
  audio_input_token: { field: 'input', category: 'standard' },
  thinking_vision_input_token: { field: 'input', category: 'standard' },
  thinking_audio_input_token: { field: 'input', category: 'standard' },

  // Batch input
  input_token_batch: { field: 'input', category: 'standard' },
  thinking_input_token_batch: { field: 'input', category: 'standard' },

  // Standard output types
  output_token: { field: 'output', category: 'standard' },
  thinking_output_token: { field: 'output', category: 'standard' },

  // Text output (distinguished by input modality)
  purein_text_output_token: { field: 'output', category: 'text_only_input' },
  thinking_purein_text_output_token: { field: 'output', category: 'text_only_input' },
  multiin_text_output_token: { field: 'output', category: 'multimodal_input' },
  thinking_multiin_text_output_token: { field: 'output', category: 'multimodal_input' },
  multi_output_token: { field: 'output', category: 'multimodal_input' },
  multi_translate_text_output_token: { field: 'output', category: 'multimodal_input' },

  // Batch output
  output_token_batch: { field: 'output', category: 'standard' },
  thinking_output_token_batch: { field: 'output', category: 'standard' },

  // Cache - explicit cache (5 minutes)
  input_token_cache_creation_5m: { field: 'cache_creation', category: 'cache' },
  input_token_cache_read: { field: 'cache_read', category: 'cache' },

  // Cache - implicit cache
  text_input_token_cache: { field: 'cache_read', category: 'cache' },
  audio_input_token_cache: { field: 'cache_read', category: 'cache' },
  vision_input_token_cache: { field: 'cache_read', category: 'cache' },
  input_token_cache: { field: 'cache_read', category: 'cache' },
  thinking_input_token_cache: { field: 'cache_read', category: 'cache' },

  // Embedding
  embedding_token: { field: 'input', category: 'standard' },
  embedding_token_batch: { field: 'input', category: 'standard' },
  embedding_image_token: { field: 'input', category: 'standard' },

  // Image generation
  image_number: { field: 'output', category: 'standard' },
  image_standard: { field: 'output', category: 'standard' },
  image_thinking: { field: 'output', category: 'standard' },

  // TTS
  cosy_tts_number: { field: 'output', category: 'standard' },
  tts_vc_model: { field: 'output', category: 'standard' },

  // Omni multimodal models (text/audio dual modes)
  omni_no_audio_input_token: { field: 'input', category: 'standard' },
  omni_no_audio_output_token: { field: 'output', category: 'standard' },
  omni_audio_input_token: { field: 'input', category: 'standard' },
  omni_audio_output_token: { field: 'output', category: 'standard' },

  // Video generation
  video_ratio: { field: 'output', category: 'standard' },
  video_ratio_480p: { field: 'output', category: 'standard' },
  video_ratio_720p: { field: 'output', category: 'standard' },
  video_ratio_1080p: { field: 'output', category: 'standard' },
  video_ratio_pro: { field: 'output', category: 'standard' },
  '720P_no_audio': { field: 'output', category: 'standard' },
  '1080P_no_audio': { field: 'output', category: 'standard' },
  video_content_duration: { field: 'output', category: 'standard' },
  content_duration: { field: 'output', category: 'standard' },
};

// ============================================================
// Heuristic price type inference (fallback)
// ============================================================

/**
 * When a price type is not in PRICE_TYPE_MAP, infer its classification by
 * parsing keywords in the name. Typical API naming format:
 * xxx_input_token, xxx_output_token, etc.
 */
function inferPriceType(type: string): { field: 'input' | 'output'; category: string } | null {
  const lower = type.toLowerCase();

  // Determine direction: input or output
  let field: 'input' | 'output' | null = null;
  if (lower.includes('input')) field = 'input';
  else if (lower.includes('output')) field = 'output';

  if (!field) return null; // Skip if direction cannot be determined

  // Determine category
  let category = 'standard';
  if (lower.includes('thinking') || lower.includes('reasoning')) category = 'thinking';
  else if (lower.includes('cached') || lower.includes('cache')) category = 'cached';

  return { field, category };
}

/**
 * Map the inferred result to a canonical key name known by downstream code,
 * ensuring tier construction can extract the price value. Only register the
 * canonical key when it is not already in use to avoid overwriting an existing
 * precise mapping.
 */
function getCanonicalAlias(field: 'input' | 'output', category: string): string | null {
  if (category === 'standard') return field === 'input' ? 'input_token' : 'output_token';
  if (category === 'thinking')
    return field === 'input' ? 'thinking_input_token' : 'thinking_output_token';
  if (category === 'cached') return 'input_token_cache';
  return null;
}

// ============================================================
// Modality type mapping
// ============================================================

const MODALITY_MAP: Record<string, ModalityType> = {
  Text: 'text',
  Image: 'image',
  Video: 'video',
  Audio: 'audio',
};

// ============================================================
// Core mapping functions
// ============================================================

/**
 * Convert the API's modality array to PRD format (lowercased).
 */
function mapModality(rawModalities: string[]): ModalityType[] {
  return rawModalities
    .map((m) => MODALITY_MAP[m])
    .filter((m): m is ModalityType => m !== undefined);
}

/**
 * Convert the API's QPM info to the PRD's RateLimits.
 *
 * Calculation logic:
 * - RPM = CountLimit / (CountLimitPeriod / 60)
 * - TPM = UsageLimit / (UsageLimitPeriod / 60)
 */
function mapRateLimits(qpmInfo?: ApiQpmInfo): RateLimits {
  if (!qpmInfo?.ModelDefault) {
    return { rpm: 0 };
  }
  const limit = qpmInfo.ModelDefault;

  // Compute requests per minute (RPM)
  const rpm = Math.round((limit.CountLimit / limit.CountLimitPeriod) * 60);

  // Compute tokens per minute (TPM) — TTS/ASR and similar models may lack UsageLimit
  const tpm =
    limit.UsageLimit && limit.UsageLimitPeriod
      ? Math.round((limit.UsageLimit / limit.UsageLimitPeriod) * 60)
      : undefined;

  return {
    rpm,
    ...(tpm !== undefined ? { tpm } : {}),
  };
}

/**
 * Convert the API's Prices array to the PRD's Pricing structure.
 *
 * Strategy:
 * 1. Group by price type (input/output/cache).
 * 2. For multimodal models, create multiple tiers per input modality.
 * 3. For simple models, create a single tier.
 * 4. Handle special model types (Embedding/TTS/Video/Image).
 */
function mapPrices(
  prices: ApiPriceItem[] | undefined,
  multiPrices?: ApiMultiPriceRange[],
): RawPricing {
  // MultiPrices takes precedence: detect non-token pricing types first,
  // then iterate over all ranges to generate tiers.
  if (multiPrices && multiPrices.length > 0) {
    const allTypes = multiPrices.flatMap((r) => r.Prices.map((p) => p.Type));

    // Image tiered pricing (e.g. image_number volume brackets)
    if (allTypes.some((t) => t.startsWith('image_'))) {
      return mapImageMultiPrices(multiPrices);
    }

    // LLM token-style tiered pricing (default)
    return mapMultiPrices(multiPrices);
  }

  const effectivePrices = prices;

  if (!effectivePrices || effectivePrices.length === 0) {
    return { tiers: [] };
  }

  // Parse all price items
  const priceMap: Record<string, number> = {};
  effectivePrices.forEach((item) => {
    const mapping = PRICE_TYPE_MAP[item.Type];
    if (mapping) {
      priceMap[item.Type] = applyDiscount(safePrice(item.Price), item.Discount);
    } else {
      // Heuristic fallback: infer price direction and category from name keywords
      const inferred = inferPriceType(item.Type);
      if (inferred) {
        const price = applyDiscount(safePrice(item.Price), item.Discount);
        priceMap[item.Type] = price;
        // Register the canonical alias so downstream tier construction can extract a value
        const canonical = getCanonicalAlias(inferred.field, inferred.category);
        if (canonical && !(canonical in priceMap)) {
          priceMap[canonical] = price;
        }
        addDiagnostic(
          'PriceMapping',
          `Inferred price type "${item.Type}" as ${inferred.field}/${inferred.category} via heuristic`,
        );
      } else {
        addDiagnostic('PriceMapping', `Unknown price type "${item.Type}" could not be classified`);
      }
    }
  });

  // All prices parsed as 0 — treat as no usable pricing data rather than
  // "free", since only `free_tier.mode === 'only'` carries reliable
  // free-only semantics.
  const allParsedPrices = effectivePrices.map((item) => safePrice(item.Price));
  if (allParsedPrices.length > 0 && allParsedPrices.every((p) => p === 0)) {
    return { tiers: [] };
  }

  // Detect model type
  const hasEmbedding = effectivePrices.some((p) => p.Type.startsWith('embedding'));
  const hasTTS = effectivePrices.some(
    (p) => p.Type.startsWith('cosy_tts') || p.Type.startsWith('tts_'),
  );
  const hasVideo = effectivePrices.some(
    (p) => p.Type.startsWith('video_') || p.Type.includes('P_no_audio'),
  );
  const hasImage = effectivePrices.some((p) => p.Type.startsWith('image_'));
  const hasContentDuration = effectivePrices.some((p) => p.Type === 'content_duration');

  // Embedding model - billed per token
  if (hasEmbedding) {
    const embeddingEntries = effectivePrices.filter((p) => p.Type.startsWith('embedding'));
    // Multiple embedding entries with distinct names → show as itemized
    // (e.g. "图片输入" + "文本输入") rather than discarding all but the first.
    if (embeddingEntries.length > 1) {
      return {
        items: embeddingEntries.map((item) => ({
          name: item.PriceName || item.Type,
          price: applyDiscount(safePrice(item.Price), item.Discount),
          unit: item.PriceUnit,
        })),
      };
    }
    const primaryEntry = embeddingEntries[0];
    return {
      per_token: {
        price: primaryEntry ? applyDiscount(safePrice(primaryEntry.Price), primaryEntry.Discount) : 0,
        unit: primaryEntry?.PriceUnit || `${CUR_LABEL}/1M tokens`,
      },
    } as Omit<EmbeddingPricing, 'summary'>;
  }

  // TTS model - billed per character
  if (hasTTS) {
    const ttsEntries = effectivePrices.filter(
      (p) => p.Type.startsWith('cosy_tts') || p.Type.startsWith('tts_'),
    );
    // Multiple TTS entries → show as itemized
    if (ttsEntries.length > 1) {
      return {
        items: ttsEntries.map((item) => ({
          name: item.PriceName || item.Type,
          price: applyDiscount(safePrice(item.Price), item.Discount),
          unit: item.PriceUnit,
        })),
      };
    }
    const ttsEntry = ttsEntries[0];
    return {
      per_character: {
        price: ttsEntry ? applyDiscount(safePrice(ttsEntry.Price), ttsEntry.Discount) : 0,
        unit: ttsEntry?.PriceUnit || `${CUR_LABEL}/1K characters`,
      },
    } as Omit<TTSPricing, 'summary'>;
  }

  // ASR model - when content_duration is present and there is no video type, return ASRPricing
  if (hasContentDuration && !hasVideo) {
    const asrEntries = effectivePrices.filter((p) => p.Type === 'content_duration');
    // Multiple ASR entries → show as itemized
    if (asrEntries.length > 1) {
      return {
        items: asrEntries.map((item) => ({
          name: item.PriceName || item.Type,
          price: applyDiscount(safePrice(item.Price), item.Discount),
          unit: item.PriceUnit,
        })),
      };
    }
    const asrEntry = asrEntries[0];
    return {
      per_second_audio: {
        price: asrEntry ? applyDiscount(safePrice(asrEntry.Price), asrEntry.Discount) : 0,
        unit: asrEntry?.PriceUnit || `${CUR_LABEL}/second`,
      },
    } as Omit<ASRPricing, 'summary'>;
  }

  // Video generation model - automatically iterate over all video price entries
  if (hasVideo) {
    const videoEntries = effectivePrices.filter(
      (p) => p.Type.startsWith('video_') || p.Type.includes('P_no_audio'),
    );
    const perSecond = videoEntries.map((entry) => ({
      resolution: entry.PriceName || entry.Type,
      price: applyDiscount(safePrice(entry.Price), entry.Discount),
      unit: `${CUR_LABEL}/second`,
    }));

    if (perSecond.length > 0) {
      return { per_second: perSecond } as Omit<VideoPerSecondPricing, 'summary'>;
    }
  }

  // Image generation model - billed per image
  if (hasImage) {
    const imageEntries = effectivePrices.filter((p) => p.Type.startsWith('image_'));
    // Multiple image entries with distinct PriceNames → show as itemized
    // rather than collapsing to a single min price.
    if (imageEntries.length > 1) {
      return {
        items: imageEntries.map((item) => ({
          name: item.PriceName || item.Type,
          price: applyDiscount(safePrice(item.Price), item.Discount),
          unit: item.PriceUnit,
        })),
      };
    }
    // Single entry — use specialised ImagePricing
    const price = imageEntries.length > 0 ? applyDiscount(safePrice(imageEntries[0].Price), imageEntries[0].Discount) : 0;
    return {
      per_image: {
        price,
        unit: `${CUR_LABEL}/image`,
      },
    } as Omit<ImagePricing, 'summary'>;
  }

  // Omni model - has both text and audio input/output; generate tiers per mode
  const hasOmniAudio = effectivePrices.some(
    (p) => p.Type.includes('omni_audio') && !p.Type.includes('no_audio'),
  );
  const hasOmniNoAudio = effectivePrices.some((p) => p.Type.includes('omni_no_audio'));

  if (hasOmniAudio || hasOmniNoAudio) {
    const tiers: PricingTier[] = [];

    // No-audio mode tier (pure text interaction)
    if (hasOmniNoAudio) {
      tiers.push({
        label: 'Text mode',
        input: priceMap['omni_no_audio_input_token'] || 0,
        output: priceMap['omni_no_audio_output_token'] || 0,
        cache_creation: null,
        cache_read: null,
        unit: `${CUR_LABEL}/1M tokens`,
      });
    }

    // Audio mode tier (audio interaction)
    if (hasOmniAudio) {
      tiers.push({
        label: 'Audio mode',
        input: priceMap['omni_audio_input_token'] || 0,
        output: priceMap['omni_audio_output_token'] || 0,
        cache_creation: null,
        cache_read: null,
        unit: `${CUR_LABEL}/1M tokens`,
      });
    }

    return { tiers } as Omit<LLMPricing, 'summary'>;
  }

  // LLM model (has text input or output) — keyword-pattern matching to avoid missing newly added price types
  const priceKeys = Object.keys(priceMap);
  const hasInputText = priceKeys.some(
    (k) =>
      k.includes('input') &&
      !k.includes('audio') &&
      !k.includes('vision') &&
      !k.includes('thinking'),
  );
  const hasThinkingInputText = priceKeys.some(
    (k) =>
      k.includes('thinking') &&
      k.includes('input') &&
      !k.includes('audio') &&
      !k.includes('vision'),
  );
  const hasInputImage = priceKeys.some((k) => k.includes('vision') && k.includes('input'));
  const hasInputAudio = priceKeys.some((k) => k.includes('audio') && k.includes('input'));
  const hasOutputText = priceKeys.some(
    (k) => k.includes('output') && !k.includes('audio') && !k.includes('thinking'),
  );
  const hasThinkingOutputText = priceKeys.some(
    (k) => k.includes('thinking') && k.includes('output'),
  );
  const hasCacheCreation = 'input_token_cache_creation_5m' in priceMap;
  const hasCacheRead = priceKeys.some(
    (k) => k.includes('cache_read') || k.includes('input_token_cache'),
  );

  if (hasInputText || hasOutputText || hasThinkingInputText || hasThinkingOutputText) {
    const tiers: PricingTier[] = [];

    // Standard mode (non-thinking)
    if (hasInputText || hasOutputText) {
      // cache_creation / cache_read are always placed on the tier as null placeholders to
      // avoid missing fields across model versions imposing branching costs on Agent
      // comparisons (report 6.6).
      const cacheCreation = hasCacheCreation
        ? priceMap['input_token_cache_creation_5m'] || 0
        : null;
      const cacheReadText = hasCacheRead
        ? (priceMap['input_token_cache_read'] ??
          priceMap['text_input_token_cache'] ??
          priceMap['input_token_cache'] ??
          0)
        : null;
      const cacheReadVision = hasCacheRead
        ? (priceMap['vision_input_token_cache'] ?? priceMap['input_token_cache'] ?? 0)
        : null;
      const cacheReadAudio = hasCacheRead
        ? (priceMap['audio_input_token_cache'] ?? priceMap['input_token_cache'] ?? 0)
        : null;

      // Pure text input
      if (hasInputText && !hasInputImage && !hasInputAudio) {
        tiers.push({
          label: 'Text input',
          input: priceMap['input_token'] || priceMap['text_input_token'] || 0,
          output: priceMap['output_token'] || priceMap['purein_text_output_token'] || 0,
          cache_creation: cacheCreation,
          cache_read: cacheReadText,
          unit: `${CUR_LABEL}/1M tokens`,
        });
      }
      // Multimodal input - create multiple tiers
      else if (hasInputText && (hasInputImage || hasInputAudio)) {
        // Text input tier
        tiers.push({
          label: 'Text input',
          input: priceMap['input_token'] || priceMap['text_input_token'] || 0,
          output: priceMap['output_token'] || priceMap['purein_text_output_token'] || 0,
          cache_creation: cacheCreation,
          cache_read: cacheReadText,
          unit: `${CUR_LABEL}/1M tokens`,
        });

        // Image input tier
        if (hasInputImage) {
          tiers.push({
            label: 'Text+Image input',
            input: priceMap['vision_input_token'] || 0,
            output: priceMap['output_token'] || priceMap['multiin_text_output_token'] || 0,
            cache_creation: cacheCreation,
            cache_read: cacheReadVision,
            unit: `${CUR_LABEL}/1M tokens`,
          });
        }

        // Audio input tier
        if (hasInputAudio) {
          tiers.push({
            label: 'Text+Audio input',
            input: priceMap['audio_input_token'] || 0,
            output: priceMap['output_token'] || priceMap['multiin_text_output_token'] || 0,
            cache_creation: cacheCreation,
            cache_read: cacheReadAudio,
            unit: `${CUR_LABEL}/1M tokens`,
          });
        }
      }
      // No text input but has multimodal input and text output (e.g. translation models)
      else if (!hasInputText && hasOutputText && (hasInputImage || hasInputAudio)) {
        // Pick the output price by type priority
        const outputPrice =
          priceMap['multi_translate_text_output_token'] ??
          priceMap['multiin_text_output_token'] ??
          priceMap['purein_text_output_token'] ??
          priceMap['output_token'] ??
          priceMap['multi_output_token'] ??
          0;

        if (hasInputImage) {
          tiers.push({
            label: 'Image input',
            input: priceMap['vision_input_token'] || 0,
            output: outputPrice,
            cache_creation: cacheCreation,
            cache_read: cacheReadVision,
            unit: `${CUR_LABEL}/1M tokens`,
          });
        }

        if (hasInputAudio) {
          tiers.push({
            label: 'Audio input',
            input: priceMap['audio_input_token'] || 0,
            output: outputPrice,
            cache_creation: cacheCreation,
            cache_read: cacheReadAudio,
            unit: `${CUR_LABEL}/1M tokens`,
          });
        }
      }
    }

    // Thinking mode
    if (hasThinkingInputText || hasThinkingOutputText) {
      const thinkingInput =
        priceMap['thinking_input_token'] || priceMap['thinking_text_input_token'] || 0;
      const thinkingOutput =
        priceMap['thinking_output_token'] || priceMap['thinking_purein_text_output_token'] || 0;
      const thinkingCacheRead = hasCacheRead ? priceMap['thinking_input_token_cache'] || 0 : null;

      tiers.push({
        label: 'Thinking mode',
        input: thinkingInput,
        output: thinkingOutput,
        cache_creation: hasCacheCreation ? priceMap['input_token_cache_creation_5m'] || 0 : null,
        cache_read: thinkingCacheRead,
        unit: `${CUR_LABEL}/1M tokens`,
      });
    }

    return { tiers } as Omit<LLMPricing, 'summary'>;
  }

  // Default: no known pricing structure matched — collect all items as
  // ItemizedPricing so the user still sees every price entry rather than a
  // blank em-dash. This is a fallback; specialised branches above handle
  // known types.
  const items: PriceItem[] = effectivePrices.map((item) => ({
    name: item.PriceName || item.Type,
    price: applyDiscount(safePrice(item.Price), item.Discount),
    unit: item.PriceUnit,
  }));
  return items.length > 0 ? { items } : { tiers: [] };
}

/**
 * Handle MultiPrices with image_* price types: generate per_image_tiers for
 * volume-bracket pricing (e.g. image_number with quantity thresholds).
 * Also populates per_image with the first tier's price for backward
 * compatibility with consumers that only read per_image.
 */
function mapImageMultiPrices(multiPrices: ApiMultiPriceRange[]): Omit<ImagePricing, 'summary'> {
  const tiers: ImageTier[] = [];

  for (const range of multiPrices) {
    const entry = range.Prices.find((p) => p.Type.startsWith('image_'));
    if (entry) {
      tiers.push({
        label: range.RangeName,
        price: applyDiscount(safePrice(entry.Price), entry.Discount),
        unit: `${CUR_LABEL}/image`,
      });
    }
  }

  // Fallback: if no image entries found, return simple empty per_image
  if (tiers.length === 0) {
    return {
      per_image: { price: 0, unit: `${CUR_LABEL}/image` },
    };
  }

  return {
    per_image: { price: tiers[0].price, unit: tiers[0].unit },
    per_image_tiers: tiers,
  };
}

/**
 * Handle MultiPrices tiered pricing: iterate over all ranges and generate one
 * PricingTier per range.
 */
function mapMultiPrices(multiPrices: ApiMultiPriceRange[]): Omit<LLMPricing, 'summary'> | Omit<ItemizedPricing, 'summary'> {
  const tiers: PricingTier[] = [];

  // LLM token-style keys this function knows how to translate into tier
  // input/output. Non-token tiered pricing (e.g. `image_number` per-image
  // brackets) does not match any of these, so the resulting tier values stay
  // at 0 — which is *not* a genuine "free" signal.
  const LLM_TOKEN_KEYS = [
    'input_token',
    'text_input_token',
    'thinking_input_token',
    'output_token',
    'purein_text_output_token',
    'thinking_output_token',
  ];
  let anyRecognized = false;

  for (const range of multiPrices) {
    // Parse all price items within this range
    const priceMap: Record<string, number> = {};
    range.Prices.forEach((item) => {
      const mapping = PRICE_TYPE_MAP[item.Type];
      if (mapping) {
        priceMap[item.Type] = applyDiscount(safePrice(item.Price), item.Discount);
      }
    });

    if (LLM_TOKEN_KEYS.some((k) => k in priceMap)) {
      anyRecognized = true;
    }

    const input =
      priceMap['input_token'] ||
      priceMap['text_input_token'] ||
      priceMap['thinking_input_token'] ||
      0;
    const output =
      priceMap['output_token'] ||
      priceMap['purein_text_output_token'] ||
      priceMap['thinking_output_token'] ||
      0;

    const cacheCreation =
      'input_token_cache_creation_5m' in priceMap
        ? priceMap['input_token_cache_creation_5m']
        : null;
    const cacheReadPrice =
      priceMap['input_token_cache_read'] ??
      priceMap['text_input_token_cache'] ??
      priceMap['input_token_cache'];
    const tier: PricingTier = {
      label: range.RangeName,
      input,
      output,
      cache_creation: cacheCreation,
      cache_read: cacheReadPrice ?? null,
      unit: `${CUR_LABEL}/1M tokens`,
    };

    tiers.push(tier);
  }

  // None of the ranges yielded a recognisable LLM token type — collect
  // all items across ranges as ItemizedPricing so no price data is lost.
  // This check MUST precede the all-zero check below because when no LLM
  // token keys were recognised, the zero input/output values are merely
  // default placeholders, not genuine "free" pricing.
  if (!anyRecognized) {
    const items: PriceItem[] = multiPrices.flatMap((range) =>
      range.Prices.map((p) => ({
        name: p.PriceName || p.Type,
        price: applyDiscount(safePrice(p.Price), p.Discount),
        unit: p.PriceUnit,
      })),
    );
    addDiagnostic(
      'PriceMapping',
      `mapMultiPrices: no LLM token-typed prices recognised across ${multiPrices.length} range(s); falling back to itemized`,
    );
    return items.length > 0 ? { items } : { tiers: [] };
  }

  // All tiers are zero — treat as no usable pricing data rather than
  // "free", since only `free_tier.mode === 'only'` carries reliable
  // free-only semantics.
  if (tiers.length > 0 && tiers.every((t) => t.input === 0 && t.output === 0)) {
    return { tiers: [] };
  }

  return { tiers };
}

// ============================================================
// FreeTier quota mapping
// ============================================================

const SHOW_UNIT_MAP: Record<string, string> = {
  // Tokens
  Tokens: 'tokens',
  Token: 'tokens',
  'Thousand Tokens': 'tokens',
  'Million Tokens': 'tokens',
  // Images
  Images: 'images',
  Image: 'images',
  Pieces: 'images',
  Piece: 'images',
  // Seconds
  Seconds: 'seconds',
  Second: 'seconds',
  // Characters
  Characters: 'characters',
  Character: 'characters',
  'Thousand Characters': 'characters',
  '10K Characters': 'characters',
  // Words / TTS / ASR (tenthousand word = "\u4e07\u5b57", treated as characters)
  Word: 'characters',
  Words: 'characters',
  'Tenthousand Word': 'characters',
  'Tenthousand Words': 'characters',
  'tenthousand word': 'characters',
  'tenthousand words': 'characters',
  '10K Words': 'characters',
  '10K Word': 'characters',
    '千 tokens': 'tokens',
  '千tokens': 'tokens',
  '千 Tokens': 'tokens',
  '千Tokens': 'tokens',
  '万字': 'characters',
  '秒': 'seconds',
  '张': 'images',
  '个': '个',
};

/**
 * Normalize a raw ShowUnit string (already lowercased) to our internal unit names.
 * Handles any variant the API might return for TTS/ASR/character-based models.
 */
function normalizeShowUnit(lower: string): string {
  if (lower.includes('token') || lower.includes('千')) return 'tokens';
  if (lower.includes('image') || lower.includes('piece') || lower.includes('page') || lower.includes('张')) return 'images';
  if (lower.includes('voice')) return 'voices';
  if (lower.includes('second') || lower.includes('sec') || lower.includes('秒')) return 'seconds';
  if (lower.includes('char') || lower.includes('word') || lower.includes('字')) return 'characters';
  // Default: pass through without conversion
  return lower;
}

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

/**
 * Convert the API's BuiltInToolMultiPrices to the PRD's BuiltInTool[].
 */
function mapBuiltInTools(tools: ApiBuiltInToolPrice[] | undefined): BuiltInTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => {
    // Take the first price (usually the primary one)
    const firstPrice = tool.Prices[0];
    return {
      name: tool.Name || tool.Type,
      price: safePrice(firstPrice?.Price || '0'),
      unit: firstPrice?.PriceUnit || '',
      api: tool.SupportedApi || 'Responses API',
    };
  });
}

/**
 * Convert the API's ModelItem to the PRD's Model (list item).
 */
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

/**
 * Convert the API's ModelItem to the PRD's ModelDetail.
 */
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
