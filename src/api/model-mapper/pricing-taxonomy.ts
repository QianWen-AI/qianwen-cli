// Pricing classification & unit-normalisation tables shared across the mapper
// slices. Pure data + lookup helpers — no side effects, no imports from the
// rest of the mapper. Includes CJK keys/keywords required by the QianWen
// (cn-beijing) backend's localised ShowUnit values.

// ============================================================
// Price type mapping table
// ============================================================

interface PriceFieldMapping {
  field: 'input' | 'output' | 'cache_creation' | 'cache_read';
  category: 'standard' | 'text_only_input' | 'multimodal_input' | 'cache';
}

export const PRICE_TYPE_MAP: Record<string, PriceFieldMapping> = {
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
 * parsing keywords in the name.
 */
export function inferPriceType(
  type: string,
): { field: 'input' | 'output'; category: string } | null {
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
export function getCanonicalAlias(field: 'input' | 'output', category: string): string | null {
  if (category === 'standard') return field === 'input' ? 'input_token' : 'output_token';
  if (category === 'thinking')
    return field === 'input' ? 'thinking_input_token' : 'thinking_output_token';
  if (category === 'cached') return 'input_token_cache';
  return null;
}

// ============================================================
// ShowUnit normalization (FreeTier quota labels)
// ============================================================

export const SHOW_UNIT_MAP: Record<string, string> = {
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
  // CJK ShowUnit values returned by the cn-beijing backend
  '千 tokens': 'tokens',
  千tokens: 'tokens',
  '千 Tokens': 'tokens',
  千Tokens: 'tokens',
  万字: 'characters',
  秒: 'seconds',
  张: 'images',
  个: '个',
};

/**
 * Normalize a raw ShowUnit string (already lowercased) to our internal unit names.
 * Handles any variant the API might return for TTS/ASR/character-based models,
 * including CJK substrings emitted by the cn-beijing backend.
 */
export function normalizeShowUnit(lower: string): string {
  if (lower.includes('token') || lower.includes('千')) return 'tokens';
  if (
    lower.includes('image') ||
    lower.includes('piece') ||
    lower.includes('page') ||
    lower.includes('张')
  )
    return 'images';
  if (lower.includes('voice')) return 'voices';
  if (lower.includes('second') || lower.includes('sec') || lower.includes('秒')) return 'seconds';
  if (lower.includes('char') || lower.includes('word') || lower.includes('字')) return 'characters';
  // Default: pass through without conversion
  return lower;
}
