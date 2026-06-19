// Model attribute mapping: modality enum normalisation, rate-limit derivation
// from QpmInfo, and built-in tool list flattening. No pricing logic lives here.

import type { ApiQpmInfo, ApiBuiltInToolPrice } from '../../types/api-models.js';
import type { ModalityType, BuiltInTool, RateLimits } from '../../types/model.js';
import { safePrice } from './pricing-summary.js';

// ============================================================
// Modality type mapping
// ============================================================

const MODALITY_MAP: Record<string, ModalityType> = {
  Text: 'text',
  Image: 'image',
  Video: 'video',
  Audio: 'audio',
};

/** Convert the API's modality array to lowercased format. */
export function mapModality(rawModalities: string[]): ModalityType[] {
  return rawModalities
    .map((m) => MODALITY_MAP[m])
    .filter((m): m is ModalityType => m !== undefined);
}

/** Convert the API's QPM info to RateLimits. */
export function mapRateLimits(qpmInfo?: ApiQpmInfo): RateLimits {
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

/** Convert the API's BuiltInToolMultiPrices to BuiltInTool[]. */
export function mapBuiltInTools(
  tools: ApiBuiltInToolPrice[] | undefined,
): BuiltInTool[] | undefined {
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
