import type { ModelDetail } from '../../../src/types/model.js';

export const mockModels = [
  // 1. qwen3.6-plus — Multimodal LLM (Text+Img+Video→Text), tiered pricing with cache, built-in tools, context 1M
  {
    id: 'qwen3.6-plus',
    description: 'Qwen3.6 native vision-language flagship, outperforming the 3.5 series across reasoning, code, and multimodal understanding.',
    tags: ['Reasoning', 'Visual Understanding', 'Text Generation'],
    modality: { input: ['text', 'image', 'video'], output: ['text'] },
    features: ['Prefix Completion', 'Function Calling', 'Cache', 'Structured Outputs', 'Batches', 'Web Search'],
    pricing: {
      tiers: [
        { label: '≤ 256K tokens', input: 0.50, output: 3.00, cache_creation: 0.625, cache_read: 0.05, unit: 'USD/1M tokens' },
        { label: '256K – 1M tokens', input: 2.00, output: 6.00, cache_creation: 2.50, cache_read: 0.20, unit: 'USD/1M tokens' },
      ],
      built_in_tools: [
        { name: 'web_search', price: 10.00, unit: 'USD/1K calls', api: 'Responses API' },
        { name: 'code_interpreter', price: 0, unit: 'free', api: 'Responses API' },
        { name: 'web_extractor', price: 0, unit: 'free', api: 'Responses API' },
        { name: 'i2i_search', price: 8.00, unit: 'USD/1K calls', api: 'Responses API' },
        { name: 't2i_search', price: 8.00, unit: 'USD/1K calls', api: 'Responses API' },
      ],
    },
    context: { context_window: 1000000, max_input: 991800, max_output: 65536 },
    rate_limits: { rpm: 15000, tpm: 5000000 },
    can_try: true,
    free_tier: { mode: 'standard', quota: { remaining: 850000, total: 1000000, unit: 'tokens', used_pct: 15 } },
    metadata: { version_tag: 'MAJOR', open_source: false, updated: '2026-04-01' },
  },

  // 2. qwen-plus — Text LLM (Text→Text), single-tier pricing, context ~128K
  {
    id: 'qwen-plus',
    description: 'Qwen Plus model, suitable for general text tasks with an excellent balance of performance and cost.',
    tags: ['Text Generation', 'General Purpose'],
    modality: { input: ['text'], output: ['text'] },
    features: ['Prefix Completion', 'Function Calling', 'Structured Outputs', 'Batches'],
    pricing: {
      tiers: [
        { label: 'All contexts', input: 0.14, output: 0.56, unit: 'USD/1M tokens' },
      ],
    },
    context: { context_window: 131072, max_input: 129024, max_output: 16384 },
    rate_limits: { rpm: 10000, tpm: 3000000 },
    can_try: true,
    free_tier: { mode: 'standard', quota: { remaining: 1000000, total: 1000000, unit: 'tokens', used_pct: 0 } },
    metadata: { version_tag: 'STABLE', open_source: false, updated: '2026-03-15' },
  },

  // 3. qwen-vl-max — Vision LLM (Text+Img+Video→Text), tiered pricing
  {
    id: 'qwen-vl-max',
    description: 'Qwen VL Max vision-language flagship model, supporting in-depth understanding and multi-turn dialogue over images and videos.',
    tags: ['Visual Understanding', 'Text Generation', 'Multimodal'],
    modality: { input: ['text', 'image', 'video'], output: ['text'] },
    features: ['Function Calling', 'Structured Outputs'],
    pricing: {
      tiers: [
        { label: '≤ 256K tokens', input: 0.52, output: 2.09, unit: 'USD/1M tokens' },
        { label: '256K – 1M tokens', input: 2.08, output: 4.18, unit: 'USD/1M tokens' },
      ],
    },
    context: { context_window: 1000000, max_input: 991800, max_output: 65536 },
    rate_limits: { rpm: 10000, tpm: 4000000 },
    can_try: true,
    free_tier: { mode: 'standard', quota: { remaining: 1000000, total: 1000000, unit: 'tokens', used_pct: 0 } },
    metadata: { version_tag: 'MAJOR', open_source: false, updated: '2026-03-20' },
  },

  // 4. qwen3-asr-flash — ASR (Audio→Text), per-second pricing
  {
    id: 'qwen3-asr-flash',
    description: 'Qwen3 ASR Flash speech recognition model, high-speed and low-latency, suitable for real-time transcription scenarios.',
    tags: ['Speech Recognition', 'ASR'],
    modality: { input: ['audio'], output: ['text'] },
    features: [],
    pricing: {
      per_second_audio: { price: 0.000035, unit: 'USD/second' },
    },
    rate_limits: { rpm: 500 },
    can_try: false,
    free_tier: { mode: null, quota: null },
    metadata: { version_tag: 'STABLE', open_source: false, updated: '2026-02-28' },
  },

  // 5. wan2.6-t2i — Image generation (Text→Image), per-image pricing
  {
    id: 'wan2.6-t2i',
    description: 'Wan2.6 text-to-image model, supporting high-quality image generation across a variety of styles and resolutions.',
    tags: ['Image Generation', 'Text to Image'],
    modality: { input: ['text'], output: ['image'] },
    features: [],
    pricing: {
      per_image: { price: 0.03, unit: 'USD/image' },
    },
    rate_limits: { rpm: 300, concurrency: 5, async_queue: 500 },
    can_try: true,
    free_tier: { mode: 'standard', quota: { remaining: 38, total: 50, unit: 'images', used_pct: 24 } },
    metadata: { version_tag: 'MAJOR', open_source: false, updated: '2026-03-10' },
  },

  // 6. wan2.7-r2v — Video generation (Img+Video→Video), per-second by resolution pricing
  {
    id: 'wan2.7-r2v',
    description: 'Wan2.7 image-to-video model, supporting high-quality video generation driven by reference images.',
    tags: ['Video Generation', 'Image to Video'],
    modality: { input: ['audio', 'image', 'text', 'video'], output: ['video'] },
    features: [],
    pricing: {
      per_second: [
        { resolution: '720P', price: 0.10, unit: 'USD/second' },
        { resolution: '1080P', price: 0.15, unit: 'USD/second' },
      ],
    },
    rate_limits: { rpm: 300, concurrency: 5, async_queue: 500 },
    can_try: true,
    free_tier: { mode: 'standard', quota: { remaining: 25, total: 25, unit: 'seconds', used_pct: 0 } },
    metadata: { version_tag: 'MAJOR', open_source: false, updated: '2026-04-03' },
  },

  // 7. cosyvoice-v3-plus — TTS (Text→Audio), per-character pricing
  {
    id: 'cosyvoice-v3-plus',
    description: 'CosyVoice speech synthesis model, supporting multilingual, multi-voice, and emotionally rich speech output.',
    tags: ['TTS', 'Speech Synthesis'],
    modality: { input: ['text'], output: ['audio'] },
    features: [],
    pricing: {
      per_character: { price: 0.26, unit: 'USD/10K characters' },
    },
    rate_limits: { rpm: 180 },
    can_try: false,
    free_tier: { mode: 'standard', quota: { remaining: 7200, total: 10000, unit: 'characters', used_pct: 28 } },
    metadata: { version_tag: 'MAJOR', open_source: false, updated: '2026-02-10' },
  },

  // 8. qwen3.5-omni-plus — Omni model (Text+Img+Video+Audio→Text+Audio), free only
  {
    id: 'qwen3.5-omni-plus',
    description: 'Qwen3.5 Omni Plus omnimodal model, supporting text, image, video, and audio inputs with text and audio outputs. Free during Early Access.',
    tags: ['Omni', 'Multimodal', 'Early Access'],
    modality: { input: ['text', 'image', 'video', 'audio'], output: ['text', 'audio'] },
    features: ['Function Calling'],
    pricing: {
      tiers: [
        { label: 'Free (Early Access)', input: 0, output: 0, unit: 'free' },
      ],
    },
    context: { context_window: 131072, max_input: 129024, max_output: 16384 },
    rate_limits: { rpm: 5000, tpm: 1000000 },
    can_try: true,
    free_tier: { mode: 'only', quota: null },
    metadata: { version_tag: 'PREVIEW', open_source: false, updated: '2026-04-05' },
  },
];
