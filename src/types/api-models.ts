// ============================================================
// API raw response type definitions
// These types directly map the JSON structure returned by the backend API.
// ============================================================

// Price item (element of Prices array / BuiltInToolMultiPrices array)
export interface ApiPriceItem {
  Type: string; // e.g. "text_input_token", "vision_input_token_cache"
  PriceUnit: string; // e.g. "Per 1M tokens"
  Price: string; // Note: string type, e.g. "0.07"
  PriceName: string; // e.g. "Input: Text"
}

// QPM rate-limit info
export interface ApiQpmLimit {
  UsageLimitField: string; // e.g. "total_tokens"
  CountLimit: number; // Request count limit
  Type: string; // e.g. "model-default"
  UsageLimit: number; // Token count limit
  CountLimitPeriod: number; // Request count limit period (seconds)
  UsageLimitPeriod: number; // Token count limit period (seconds)
}

export interface ApiQpmInfo {
  ModelDefault: ApiQpmLimit;
  ModelDefaultActual?: ApiQpmLimit;
}

// Inference metadata (multimodal info)
export interface ApiInferenceMetadata {
  RequestModality: string[]; // e.g. ["Text", "Image", "Video", "Audio"]
  ResponseModality: string[]; // e.g. ["Text", "Audio"]
}

// Model specification info
export interface ApiModelInfo {
  ContextWindow: number;
  MaxInputTokens: number;
  MaxOutputTokens: number;
}

// Model capability support
export interface ApiModelSupports {
  Sft: boolean;
  App: boolean;
  Dpo: boolean;
  WorkflowText: boolean;
  CheckpointImport: boolean;
  WorkflowMultimodal: boolean;
  Cpt: boolean;
  Inference: boolean;
  Workflow: boolean;
  Deploy: boolean;
  SelfServiceLimitIncrease: boolean;
  Experience: boolean; // -> can_try
  SellingByQpm: boolean;
  AppV1: boolean;
  ExperienceUpcoming: boolean;
  AppV2: boolean;
  DisplayQpmLimit: boolean;
  Tokenizer: boolean;
  Eval: boolean;
  FineTune: boolean;
}

// Model permissions
export interface ApiModelPermissions {
  Inference: boolean;
}

// Sample code (currently an empty object)
export interface ApiSampleCodeV2 {
  Openai?: Record<string, unknown>;
}

// Built-in tool price item
export interface ApiBuiltInToolPrice {
  Type: string; // Tool type, e.g. "web_search"
  Name: string; // Tool name
  Prices: Array<{
    PriceUnit: string; // e.g. "Per 1K calls"
    Price: string; // Price string
    Currency?: string; // e.g. "CNY"
  }>;
  DocUrl?: string; // Documentation URL
  SupportedApi?: string; // Supported API, e.g. "Responses API"
}

// Multi-price range (element of MultiPrices array)
export interface ApiMultiPriceRange {
  RangeName: string;
  Prices: ApiPriceItem[];
}

// Concrete model version (element of Items array) — this is the data actually consumed by the CLI
export interface ApiModelItem {
  // Basic info
  Model: string; // Model ID, e.g. "qwen-omni-turbo" (globally unique)
  Name: string; // Display name, e.g. "Qwen-Omni-Turbo"
  Description: string; // Full description
  ShortDescription: string; // Short description
  Category: string; // Category, e.g. "Older"
  Language: string; // e.g. "en-US"

  // Identifiers
  DataId: string;
  GroupModel: string; // Owning series name
  EquivalentSnapshot?: string; // Equivalent snapshot version
  VersionTag: string; // e.g. "MAJOR"

  // Status flags
  ActivationStatus: number; // Activation status (meaning to be confirmed)
  Scope: string; // e.g. "PUBLIC"
  OpenSource: boolean;
  FreeTierOnly: boolean; // Free-only flag
  NeedApply: boolean; // Whether application is required
  AliyunRecommend: boolean;

  // Timestamps
  UpdateAt?: string; // ISO 8601 format
  LatestOnlineAt: string; // ISO 8601 format

  // Multimodal
  InferenceMetadata?: ApiInferenceMetadata;
  Capabilities: string[]; // e.g. ["Multimodal-Omni"]

  // Pricing
  Prices?: ApiPriceItem[];
  MultiPrices?: ApiMultiPriceRange[]; // Tiered pricing by input length
  BuiltInToolMultiPrices?: ApiBuiltInToolPrice[]; // Built-in tool pricing

  // Specifications
  ModelInfo: ApiModelInfo;
  ContextWindow: number; // Redundant field, same as ModelInfo
  MaxInputTokens: number; // Redundant field, same as ModelInfo
  MaxOutputTokens: number; // Redundant field, same as ModelInfo

  // Rate limiting
  QpmInfo: ApiQpmInfo;

  // Capability support
  Supports?: ApiModelSupports;
  Permissions: ApiModelPermissions;
  Features: string[]; // e.g. ["cache", "model-experience"]
  Tags?: string[];
  InferenceProvider: string; // e.g. "bailian"
  Provider: string; // e.g. "qwen"

  // Misc
  SampleCodeV2: ApiSampleCodeV2;
  ApplyType: number;
}

// Model series / group (outer wrapper)
export interface ApiModelGroup {
  Group: boolean;
  Name: string; // Series name, e.g. "Qwen-Omni-Turbo"
  DataId: string;
  Providers: string[]; // e.g. ["qwen"]
  LatestOnlineAt: string;
  InstanceLatestOnlineAt: string;
  ActivationStatus: number;
  UpdateAt: string;
  Supports: ApiModelSupports;
  Language: string;
  Permissions: ApiModelPermissions;
  Features: string[];
  Items: ApiModelItem[]; // Actual list of model versions
  ApplyType: number;
}

// API list response structure
export interface ApiModelsListResponse {
  requestId: string;
  code: string;
  message: string | null;
  action: string | null;
  apiName: string | null;
  data: {
    Data: ApiModelGroup[];
  };
}

// ============================================================
// DescribeFqInstance API types (FreeTier quota query)
// ============================================================

export interface FqCapacity {
  BaseValue: number;
  ShowUnit: string;
  ShowValue: string;
}

export interface FqInstanceItem {
  InstanceName: string;
  Status: string;
  Uid: number;
  InitCapacity: FqCapacity;
  CurrCapacity: FqCapacity;
  Template: { Code: string; Name: string };
  StartTime: string;
  EndTime: string;
  CurrentCycleStartTime: string;
  CurrentCycleEndTime: string;
}

export interface FqInstanceResponse {
  TotalCount: number;
  PageSize: number;
  RequestId: string;
  CurrentPage: number;
  Data: FqInstanceItem[];
}

// ============================================================
// MaasListConsumeSummary API types (Pay-as-you-go billing)
// ============================================================

export interface ConsumeSummaryLineItem {
  LineItemCategory?: string; // e.g. "LLM Token Consumption", "Free Tier Image Generation"
  BillingItemCode?: string; // e.g. "image_number", "token_number", "char_number", "video_duration"
  BillingDate?: string; // YYYY-MM-DD
  BillingMonth?: string; // YYYY-MM
  ModelName?: string; // model ID like "qwen-plus"
  Model?: string; // alternative model ID field
  BillQuantity?: number; // quantity in step units
  StepQuantityUnit?: string; // e.g. "1K tokens", "seconds", "Page"
  RequireAmount?: number; // actual charged amount
  Amount?: number; // alternative amount field
  Cost?: number; // alternative cost field
  ListPrice?: number; // list price (fallback)
}

export interface ConsumeSummaryResponse {
  Data: ConsumeSummaryLineItem[];
  TotalCount?: number;
  RequestId?: string;
}

// ============================================================
// DescribeFrInstances API types (Token Plan instance query)
// ============================================================

export interface FrInstanceItem {
  InstanceId: string;
  CommodityCode: string;
  CommodityName?: string; // e.g. "Token Plan Team Edition"
  TemplateName?: string; // e.g. "Token Plan 团队版（月）"
  Status: { Code: string; Name?: string } | string; // { Code: "valid", Name: "Valid" } | "valid"
  StatusCode?: string; // flat status code, e.g. "valid"
  StatusName?: string; // human-readable status, e.g. "有效" / "Valid"
  InitCapacityBaseValue: string; // total credits (string-encoded number)
  CurrCapacityBaseValue: string; // remaining credits
  periodCapacityBaseValue?: string; // period-based remaining (used when CapacityTypeCode=periodMonthlyShift)
  CapacityTypeCode?: string; // e.g. "periodMonthlyShift"
  EndTime?: number; // ms timestamp
  EnableRenew?: boolean;
}

export interface FrInstanceResponse {
  TotalCount?: number;
  PageSize?: number;
  RequestId?: string;
  CurrentPage?: number;
  Data: FrInstanceItem[];
}

// API single-model detail response (same structure as an Items element)
export interface ApiModelDetailResponse {
  requestId: string;
  code: string;
  message: string | null;
  action: string | null;
  apiName: string | null;
  data: ApiModelItem;
}
