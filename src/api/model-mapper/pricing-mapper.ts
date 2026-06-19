// Price-list to Pricing mapping: turns API Prices / MultiPrices arrays into
// the internal RawPricing shape. This is the largest slice of the mapper and
// owns the per-modality branching that historically lived in mapPrices().

import type { ApiPriceItem, ApiMultiPriceRange } from '../../types/api-models.js';
import type {
  LLMPricing,
  VideoPerSecondPricing,
  ImagePricing,
  TTSPricing,
  ASRPricing,
  EmbeddingPricing,
  ItemizedPricing,
  PricingTier,
  ImageTier,
  PriceItem,
} from '../../types/model.js';
import { addDiagnostic } from '../debug-buffer.js';
import { site } from '../../site.js';
import { safePrice, applyDiscount, type RawPricing } from './pricing-summary.js';
import { PRICE_TYPE_MAP, inferPriceType, getCanonicalAlias } from './pricing-taxonomy.js';

/** Currency label used in pricing unit strings (e.g. "CNY/1M tokens" or "USD/1M tokens"). */
const CUR_LABEL = site.features.currency;

/** Convert the API's Prices array to the public Pricing structure. */
export function mapPrices(
  prices: ApiPriceItem[] | undefined,
  multiPrices?: ApiMultiPriceRange[],
): RawPricing {
  // Defensive pre-filter: certain models (e.g. qwen-image-2.0-pro) come back
  // with malformed payloads such as `MultiPrices: [{ Prices: [{}] }]` whose
  // entries lack the `Type` discriminator. Dropping those entries up front
  // keeps every Type-keyed branch below safe from `undefined.startsWith()`.
  const sanitizedMultiPrices = multiPrices
    ?.map((r) => ({ ...r, Prices: r.Prices.filter((p) => p.Type) }))
    .filter((r) => r.Prices.length > 0);
  const sanitizedPrices = prices?.filter((p) => p.Type);

  // MultiPrices takes precedence: detect non-token pricing types first,
  // then iterate over all ranges to generate tiers.
  if (sanitizedMultiPrices && sanitizedMultiPrices.length > 0) {
    const allTypes = sanitizedMultiPrices
      .flatMap((r) => r.Prices.map((p) => p.Type))
      .filter(Boolean);

    // Image tiered pricing (e.g. image_number volume brackets)
    if (allTypes.some((t) => t?.startsWith('image_'))) {
      return mapImageMultiPrices(sanitizedMultiPrices);
    }

    // LLM token-style tiered pricing (default)
    return mapMultiPrices(sanitizedMultiPrices);
  }

  const effectivePrices = sanitizedPrices;

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
      // Heuristic fallback for unrecognized price types.
      const inferred = inferPriceType(item.Type);
      if (inferred) {
        const price = applyDiscount(safePrice(item.Price), item.Discount);
        priceMap[item.Type] = price;
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
  // Optional chaining is layered on top of the entry-level sanitisation above
  // as a belt-and-braces guard, so any future caller that bypasses sanitisation
  // (or any new malformed payload shape) still cannot crash these probes.
  const hasEmbedding = effectivePrices.some((p) => p.Type?.startsWith('embedding'));
  const hasTTS = effectivePrices.some(
    (p) => p.Type?.startsWith('cosy_tts') || p.Type?.startsWith('tts_'),
  );
  const hasVideo = effectivePrices.some(
    (p) => p.Type?.startsWith('video_') || p.Type?.includes('P_no_audio'),
  );
  const hasImage = effectivePrices.some((p) => p.Type?.startsWith('image_'));
  const hasContentDuration = effectivePrices.some((p) => p.Type === 'content_duration');

  // Embedding model - billed per token
  if (hasEmbedding) {
    const embeddingEntries = effectivePrices.filter((p) => p.Type?.startsWith('embedding'));
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
        price: primaryEntry
          ? applyDiscount(safePrice(primaryEntry.Price), primaryEntry.Discount)
          : 0,
        unit: primaryEntry?.PriceUnit || `${CUR_LABEL}/1M tokens`,
      },
    } as Omit<EmbeddingPricing, 'summary'>;
  }

  // TTS model - billed per character
  if (hasTTS) {
    const ttsEntries = effectivePrices.filter(
      (p) => p.Type?.startsWith('cosy_tts') || p.Type?.startsWith('tts_'),
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
      (p) => p.Type?.startsWith('video_') || p.Type?.includes('P_no_audio'),
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
    const imageEntries = effectivePrices.filter((p) => p.Type?.startsWith('image_'));
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
    const price =
      imageEntries.length > 0
        ? applyDiscount(safePrice(imageEntries[0].Price), imageEntries[0].Discount)
        : 0;
    return {
      per_image: {
        price,
        unit: `${CUR_LABEL}/image`,
      },
    } as Omit<ImagePricing, 'summary'>;
  }

  // Omni model - has both text and audio input/output; generate tiers per mode
  const hasOmniAudio = effectivePrices.some(
    (p) => p.Type?.includes('omni_audio') && !p.Type?.includes('no_audio'),
  );
  const hasOmniNoAudio = effectivePrices.some((p) => p.Type?.includes('omni_no_audio'));

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
export function mapImageMultiPrices(
  multiPrices: ApiMultiPriceRange[],
): Omit<ImagePricing, 'summary'> {
  const tiers: ImageTier[] = [];

  for (const range of multiPrices) {
    const entry = range.Prices.find((p) => p.Type?.startsWith('image_'));
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
export function mapMultiPrices(
  multiPrices: ApiMultiPriceRange[],
): Omit<LLMPricing, 'summary'> | Omit<ItemizedPricing, 'summary'> {
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
