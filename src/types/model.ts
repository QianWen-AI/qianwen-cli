// Modality for a model
export interface Modality {
  input: ModalityType[];
  output: ModalityType[];
}

export type ModalityType = 'text' | 'image' | 'video' | 'audio' | 'vector';

// Free tier info
export interface FreeTier {
  mode: 'standard' | 'only' | null;
  quota: FreeTierQuota | null;
}

export interface FreeTierQuota {
  remaining: number;
  total: number;
  unit: string; // 'tokens' | 'images' | 'seconds' | 'characters'
  used_pct: number;
  status?: 'valid' | 'exhaust' | 'expire'; // quota status: valid/exhaust/expire
  // ISO 8601 UTC timestamp ("2026-06-17T00:00:00.000Z"). Always present in JSON
  // output — `null` when the model has no reset date — so Agents don't need to
  // distinguish "field missing" from "no reset" (report 6.4).
  resetDate?: string | null;
}

// Pricing - multiple variants based on model type
// LLM tiered pricing.
//
// `cache_creation` / `cache_read` are always present (null when the model has
// no cache pricing) so Agents comparing tiers across model versions don't have
// to branch on field existence — see report 6.6.
export interface PricingTier {
  label: string;
  input: number;
  output: number;
  cache_creation?: number | null;
  cache_read?: number | null;
  unit: string;
}

export interface BuiltInTool {
  name: string;
  price: number;
  unit: string;
  api: string;
}

/**
 * Normalized pricing summary present on every Pricing variant. Lets Agents
 * sort/compare candidates without branching on the underlying pricing shape
 * (text tiers vs per_image vs per_second vs per_token, etc.). See report 6.3.
 *
 * - `cheapest_input` / `cheapest_output`: minimum positive price across the
 *   variant; for non-token variants only `cheapest_output` is meaningful and
 *   `cheapest_input` is 0.
 * - `unit`: human label of the original variant's unit (e.g. `CNY/1M tokens`,
 *   `CNY/image`).
 * - `billing_type`: the dimension being billed; lets Agents group candidates.
 */
export interface PricingSummary {
  cheapest_input: number;
  cheapest_output: number;
  unit: string;
  billing_type: 'token' | 'image' | 'second' | 'character' | 'free' | 'unknown';
}

// Different pricing structures. Every variant carries a `summary` for
// cross-shape comparisons (see PricingSummary).
export interface LLMPricing {
  tiers: PricingTier[];
  built_in_tools?: BuiltInTool[];
  summary?: PricingSummary;
}

export interface VideoPerSecondPricing {
  per_second: Array<{ resolution: string; price: number; unit: string }>;
  summary?: PricingSummary;
}

export interface ImagePricing {
  per_image: { price: number; unit: string };
  summary?: PricingSummary;
}

export interface TTSPricing {
  per_character: { price: number; unit: string };
  summary?: PricingSummary;
}

export interface ASRPricing {
  per_second_audio: { price: number; unit: string };
  summary?: PricingSummary;
}

export interface EmbeddingPricing {
  per_token: { price: number; unit: string };
  summary?: PricingSummary;
}

export type Pricing =
  | LLMPricing
  | VideoPerSecondPricing
  | ImagePricing
  | TTSPricing
  | ASRPricing
  | EmbeddingPricing;

// Context info (LLM only)
export interface Context {
  context_window: number;
  max_input?: number;
  max_output?: number;
}

// Rate limits (varies by model type)
export interface RateLimits {
  rpm: number;
  tpm?: number;
  concurrency?: number;
  async_queue?: number;
}

// Metadata
export interface ModelMetadata {
  version_tag: string;
  open_source: boolean;
  updated: string;
  category?: string; // e.g. "Flagship", "Standard", "Older"
  snapshot?: string; // EquivalentSnapshot pinned version ID
}

// Model list item (for models list command).
// `features` and `context` are populated for free by the API mapper — Agents
// rely on them to filter candidates without an extra `models info` round-trip.
export interface Model {
  id: string;
  modality: Modality;
  can_try: boolean;
  free_tier: FreeTier;
  pricing?: Pricing;
  features?: string[];
  context?: Context;
}

// Full model detail (for models info command)
export interface ModelDetail extends Model {
  description: string;
  tags: string[];
  features: string[];
  pricing: Pricing;
  context?: Context;
  rate_limits: RateLimits;
  metadata: ModelMetadata;
}

// Models list response
export interface ModelsListResponse {
  models: Model[];
  total: number;
}
