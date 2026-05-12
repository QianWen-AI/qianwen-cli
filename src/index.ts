// Version is injected at build time via tsup `define: { __VERSION__ }`.
// Falls back to the literal string for test/dev environments where the
// define replacement has not been applied.
declare const __VERSION__: string;
export const VERSION: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0';

// UI Components
export * from './ui/index.js';

// Types
export type {
  Modality,
  ModalityType,
  FreeTier,
  FreeTierQuota,
  PricingTier,
  BuiltInTool,
  LLMPricing,
  VideoPerSecondPricing,
  ImagePricing,
  TTSPricing,
  ASRPricing,
  EmbeddingPricing,
  Pricing,
  Context,
  RateLimits,
  ModelMetadata,
  Model,
  ModelDetail,
  ModelsListResponse,
  UsageSummaryResponse,
  FreeTierUsage,
  TokenPlan,
  PayAsYouGo,
  PayAsYouGoModel,
  UsageBreakdownResponse,
  UsageBreakdownRow,
  UsageBreakdownTotal,
  Credentials,
  UserInfo,
  AuthStatus,
  DeviceFlowInitResponse,
  DeviceFlowPollResponse,
  ConfigSchema,
  ConfigKey,
  OutputFormat,
  ResolvedFormat,
  ConfigEntry,
} from './types/index.js';

// API
export type {
  ApiClient,
  ListModelsOptions,
  UsageSummaryOptions,
  UsageBreakdownOptions,
} from './api/client.js';
export { createClient } from './api/client.js';
export { HttpApiClient } from './api/http-client.js';

// Cache utilities
export {
  MemoryCache,
  getGlobalCache,
  resetGlobalCache,
  CacheKeys,
  CacheTTL,
} from './utils/cache.js';
