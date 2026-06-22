export interface ApiPriceItem {
  Type: string;
  PriceUnit: string;
  Price: string;
  PriceName: string;
  Discount?: string;
}

export interface ApiQpmLimit {
  UsageLimitField: string;
  CountLimit: number;
  Type: string;
  UsageLimit: number;
  CountLimitPeriod: number;
  UsageLimitPeriod: number;
}

export interface ApiQpmInfo {
  ModelDefault: ApiQpmLimit;
  ModelDefaultActual?: ApiQpmLimit;
}

export interface ApiInferenceMetadata {
  RequestModality: string[];
  ResponseModality: string[];
}

export interface ApiModelInfo {
  ContextWindow: number;
  MaxInputTokens: number;
  MaxOutputTokens: number;
}

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
  Experience: boolean;
  SellingByQpm: boolean;
  AppV1: boolean;
  ExperienceUpcoming: boolean;
  AppV2: boolean;
  DisplayQpmLimit: boolean;
  Tokenizer: boolean;
  Eval: boolean;
  FineTune: boolean;
}

export interface ApiModelPermissions {
  Inference: boolean;
}

export interface ApiSampleCodeV2 {
  Openai?: Record<string, unknown>;
}

export interface ApiBuiltInToolPrice {
  Type: string;
  Name: string;
  Prices: Array<{
    PriceUnit: string;
    Price: string;
    Currency?: string;
  }>;
  DocUrl?: string;
  SupportedApi?: string;
}

export interface ApiMultiPriceRange {
  RangeName: string;
  Prices: ApiPriceItem[];
}

export interface ApiModelItem {
  Model: string;
  Name: string;
  Description: string;
  ShortDescription: string;
  Category: string;
  Language: string;

  DataId: string;
  GroupModel: string;
  EquivalentSnapshot?: string;
  VersionTag: string;

  ActivationStatus: number;
  Scope: string;
  OpenSource: boolean;
  FreeTierOnly: boolean;
  NeedApply: boolean;
  AliyunRecommend: boolean;

  UpdateAt?: string;
  LatestOnlineAt: string;

  InferenceMetadata?: ApiInferenceMetadata;
  Capabilities: string[];

  Prices?: ApiPriceItem[];
  MultiPrices?: ApiMultiPriceRange[];
  BuiltInToolMultiPrices?: ApiBuiltInToolPrice[];

  ModelInfo: ApiModelInfo;
  ContextWindow: number;
  MaxInputTokens: number;
  MaxOutputTokens: number;

  QpmInfo: ApiQpmInfo;

  Supports?: ApiModelSupports;
  Permissions: ApiModelPermissions;
  Features: string[];
  Tags?: string[];
  InferenceProvider: string;
  Provider: string;

  SampleCodeV2: ApiSampleCodeV2;
  ApplyType: number;
}

export interface ApiModelGroup {
  Group: boolean;
  Name: string;
  DataId: string;
  Providers: string[];
  LatestOnlineAt: string;
  InstanceLatestOnlineAt: string;
  ActivationStatus: number;
  UpdateAt: string;
  Supports: ApiModelSupports;
  Language: string;
  Permissions: ApiModelPermissions;
  Features: string[];
  Items: ApiModelItem[];
  ApplyType: number;
}

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

export interface ConsumeSummaryLineItem {
  LineItemCategory?: string;
  BillingItemCode?: string;
  BillingDate?: string;
  BillingMonth?: string;
  ModelName?: string;
  Model?: string;
  JobId?: string;
  MaasTypeName?: string;
  BillQuantity?: number;
  StepQuantityUnit?: string;
  RequireAmount?: number;
  Amount?: number;
  Cost?: number;
  ListPrice?: number;
}

export interface ConsumeSummaryResponse {
  Data: ConsumeSummaryLineItem[];
  TotalCount?: number;
  RequestId?: string;
}

export interface FrInstanceItem {
  InstanceId: string;
  CommodityCode: string;
  CommodityName?: string;
  TemplateName?: string;
  Status: { Code: string; Name?: string } | string;
  StatusCode?: string;
  StatusName?: string;
  InitCapacityBaseValue: string;
  CurrCapacityBaseValue: string;
  periodCapacityBaseValue?: string;
  CapacityTypeCode?: string;
  EndTime?: number;
  EnableRenew?: boolean;
}

export interface FrInstanceResponse {
  TotalCount?: number;
  PageSize?: number;
  RequestId?: string;
  CurrentPage?: number;
  Data: FrInstanceItem[];
}

export interface ApiModelDetailResponse {
  requestId: string;
  code: string;
  message: string | null;
  action: string | null;
  apiName: string | null;
  data: ApiModelItem;
}

export interface DescribeUsageLimitResponse {
  Status?: string;
  LimitAmount?: string | number;
  Currency?: string;
  AlertThreshold?: string | number;
  Receivers?: string[];
  ReceiversMap?: Record<string, string[]>;
  RequestId?: string;
}

export interface CostAnalysisDataPoint {
  Period?: string;
  Amount?: string | number;
}

export interface CostAnalysisGroupByItem {
  Key?: string;
  Name?: string;
  Amount?: string | number;
  Percentage?: string;
}

export interface MaasDescribeCostAnalysisResponse {
  Items?: CostAnalysisDataPoint[];
  GroupByTotal?: CostAnalysisGroupByItem[];
  CostTotals?: { Amount?: string | number; Currency?: string };
  ResultByTime?: Array<{
    Period?: string;
    Total?: { Amount?: string | number; Currency?: string };
    PeriodDetails?: CostAnalysisGroupByItem[];
  }>;
  Granularity?: string;
  Currency?: string;
  TotalAmount?: string | number;
  RequestId?: string;
}

export interface SettleBillTotalItem {
  BillingCycle?: string;
  TotalPriceSettleFee?: string | number;
  TotalPriceTaxFee?: string | number;
  TotalPricePostTaxFee?: string | number;
  Currency?: string;
  PretaxAmount?: string | number;
  Tax?: string | number;
  AftertaxAmount?: string | number;
  Discount?: string | number;
  PaidAmount?: string | number;
  OutstandingAmount?: string | number;
}

export interface ListSettleBillTotalSummaryResponse {
  Data?: SettleBillTotalItem[];
  Currency?: string;
  RequestId?: string;
}

export interface QuerySubscriptionGrayResponse {
  IsGray?: boolean;
  RequestId?: string;
}

export interface SeatSubscriptionEquityItem {
  EquityCode?: string;
  EquityType?: string;
  TotalValue?: string;
  SurplusValue?: string;
}

export interface SeatSubscriptionGroupItem {
  SpecType?: string;
  SubscriptionTotalNumber?: number;
  SubscriptionAssignedNumber?: number;
  TotalValue?: string;
  SurplusValue?: string;
  NextCycleFlushTime?: string | number;
  EquityList?: SeatSubscriptionEquityItem[];
  SubscriptionList?: Array<{ InstanceCode?: string; InstanceId?: string }>;
}

export interface GetSeatSubscriptionSummaryDataInner {
  Uid?: number | string;
  ProductCode?: string;
  PlanName?: string;
  PlanCode?: string;
  PeriodStart?: string;
  PeriodEnd?: string;
  Seats?: number;
  StartTime?: string | number;
  EndTime?: string | number;
  RemainingDays?: number | string;
  SubscriptionGroupList?: SeatSubscriptionGroupItem[];
}

export interface GetSeatSubscriptionSummaryResponse extends GetSeatSubscriptionSummaryDataInner {
  RequestId?: string;
  Message?: string;
  Code?: string;
  Success?: boolean;
  Data?: GetSeatSubscriptionSummaryDataInner;
}

export interface GetSubscriptionSummaryDataInner {
  Uid?: number | string;
  ProductCode?: string;
  TotalValue?: string;
  TotalSurplusValue?: string;
  TotalCount?: number;
  NearestExpireDate?: string | number;
}

export interface GetSubscriptionSummaryResponse extends GetSubscriptionSummaryDataInner {
  RequestId?: string;
  Message?: string;
  Code?: string;
  Success?: boolean;
  Data?: GetSubscriptionSummaryDataInner;
}

export interface SubscriptionDetailEquityItem {
  EquityCode?: string;
  EquityType?: string;
  CycleTotalValue?: string;
  CycleSurplusValue?: string;
  CycleStartTime?: string | number;
  CycleEndTime?: string | number;
  Unit?: string;
  TotalValue?: string;
  SurplusValue?: string;
}

export interface SubscriptionDetailItem {
  InstanceId?: string;
  InstanceCode?: string;
  Status?: string;
  PlanName?: string;
  PlanCode?: string;
  ProductCode?: string;
  StartTime?: string | number;
  EndTime?: string | number;
  MemberId?: string;
  SpecType?: string;
  ProductType?: string;
  PayMode?: string;
  Assignable?: boolean;
  Config?: string;
  EquityList?: SubscriptionDetailEquityItem[];
}

export interface GetSubscriptionDetailDataInner {
  SubscriptionList?: SubscriptionDetailItem[];
  TotalCount?: number;
  PageSize?: number;
  CurrentPage?: number;
  PageNo?: number;
}

export interface GetSubscriptionDetailResponse {
  Data?: SubscriptionDetailItem[] | GetSubscriptionDetailDataInner;
  TotalCount?: number;
  PageSize?: number;
  CurrentPage?: number;
  Code?: string;
  Success?: boolean;
  RequestId?: string;
}

export interface CheckTokenPlanAutoRenewalResponse {
  EnableRenew?: boolean;
  AutoRenewal?: boolean;
  Enable?: boolean;
  RequestId?: string;
  Data?: {
    AutoRenewal?: number | boolean;
    RenewalPeriod?: number;
    RenewalPeriodUnit?: string;
  };
}

export interface CheckInstancesRenewableResponse {
  Renewable?: boolean;
  RequestId?: string;
  Data?: Array<{
    InstanceId?: string;
    CommodityCode?: string;
    CommodityName?: string;
    CanRenew?: boolean;
    canRenew?: boolean;
    InterceptCode?: string;
  }>;
}

export interface OrderListItem {
  OrderId?: string;
  OrderType?: string;
  OrderStatus?: string;
  DisplayStatus?: string;
  GmtCreate?: string;
  GmtPay?: string;
  OrderTime?: string;
  PayAmount?: string | number;
  TradeAmount?: string | number;
  CashAmount?: string | number;
  OriginalAmount?: string | number;
  PostTaxAmount?: string;
  PretaxAmount?: string;
  Amount?: string | number;
  Currency?: string;
  SettCurrency?: string;
  Status?: string;
  CommodityCode?: string;
  CommodityName?: string;
}

export interface QueryOrderListResponse {
  Data?: OrderListItem[];
  TotalCount?: number;
  PageSize?: number;
  CurrentPage?: number;
  RequestId?: string;
  Code?: string;
  Message?: string;
  Success?: boolean;
}

export interface OrderDetailLineItem {
  Name?: string;
  Quantity?: number;
  Amount?: string | number;
}

export interface OrderDetailItem {
  OrderId?: string;
  OrderType?: string;
  OrderTime?: string;
  Amount?: string | number;
  Currency?: string;
  Status?: string;
  Items?: OrderDetailLineItem[];
  InvoiceUrl?: string;
}

export type QueryOrderDetailResponse = OrderDetailItem;
