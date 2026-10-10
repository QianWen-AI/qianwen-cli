export type RouteType = 'A' | 'B';

// Product constants (used across API routing layers)
export const API_PRODUCT_ACCOUNT_CENTER = 'AccountCenter';
/** Product identifier for model delivery service. */
export const API_PRODUCT_DELIVERY = 'AliyunDeliveryService';
/** Product identifier for billing service. */
export const API_PRODUCT_BSS = 'BssOpenAPI-V3';
export const API_PRODUCT_BSS_PAYMENT = 'BssOpenApi';
export const API_PRODUCT_ORCHESTRATION = 'occa-payment';
export const API_PRODUCT_MODEL_STUDIO_REGIONAL = 'ModelStudioRegional';
export const API_ACTION_GENERATE_CLI_ACCESS_TOKEN = 'GenerateCLIAccessToken';
export const API_VERSION_GENERATE_CLI_ACCESS_TOKEN = '2026-02-10';
/** Product identifier for gateway service. */
export const API_PRODUCT_GATEWAY = 'sfm_bailian';
export const API_PRODUCT_SEARCH = 'aliyun-search-maas';
/** Product identifier for support ticket service. */
export const API_PRODUCT_WORKORDER = 'Workorder';
/** Product identifier for the website portal (SkillHub search/install). */
export const API_PRODUCT_WEBSITE_PORTAL = 'WebsitePortal';
/** Product identifier for yunqi (forum) service. */
export const API_PRODUCT_MAAS_PORTAL = 'MaasPortal';

// Action constants
export const API_ACTION_LIST_MODELS = 'ListModelSeries';
export const API_ACTION_DESCRIBE_FQ = 'DescribeFqInstance';
export const API_ACTION_DESCRIBE_FR = 'DescribeFrInstances';
export const API_ACTION_GATEWAY = 'BroadScopeAspnGateway';
export const API_VERSION_GATEWAY = '1.0';
export const API_ACTION_CONSUME_SUMMARY = 'MaasListConsumeSummary';
export const API_ACTION_SEARCH_ALL = 'SearchAll';

export const API_ACTION_GET_COMMODITY = 'GetCommodity';
export const API_ACTION_QUERY_FOR_CSS_ORDER = 'QueryForCssOrder';
export const API_ACTION_QUERY_ORDER_LIGHT = 'QueryOrderLight';
export const API_ACTION_DESCRIBE_MULTI_PRICE = 'DescribeMultiPrice';
export const API_ACTION_CHECK_INVENTORY = 'CheckInventory';
export const API_ACTION_CREATE_ORDER = 'CreateOrder';
export const API_ACTION_CREATE_MULTI_ORDER = 'CreateMultiOrder';
export const API_ACTION_MERGE_PAY = 'MergePay';
export const API_ACTION_QUERY_PAY_RESULT = 'QueryPayResult';
export const API_ACTION_GET_USER_INSTANCE_SUMMARY = 'GetUserInstanceSummary';
export const API_ACTION_QUERY_SUBSCRIPTION_GRAY = 'QuerySubscriptionGray';
export const API_ACTION_GET_BILLING_ACCOUNT_AVAILABLE_AMOUNT = 'GetBillingAccountAvailableAmount';
export const API_ACTION_GET_FUND_ACCOUNT_AVAILABLE_AMOUNT = 'GetFundAccountAvailableAmount';
export const API_ACTION_GET_USER_PAYMENT_METHOD = 'GetUserPaymentMethod';
export const API_ACTION_QUERY_ORDER_DETAIL = 'QueryOrderDetail';
export const API_ACTION_QUERY_AVAILABLE_INSTANCES = 'QueryAvailableInstances';
export const API_VERSION_MERGE_PAY = '2017-12-14';
export const API_VERSION_USER_INSTANCE_SUMMARY = '2023-09-30';
export const API_TOKENPLAN_SOLO_SUBSCRIPTION =
  'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription';
export const API_TOKENPLAN_SOLO_QUOTA_CONFIG =
  'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config';
export const API_TOKENPLAN_SOLO_USAGE = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';

export const API_ORCHESTRATION_PATH = '/data/custom.json';
export const API_PUBLIC_ORCHESTRATION_PATH = '/data/publicCustom.json';
export type OrchestrationPath =
  | typeof API_ORCHESTRATION_PATH
  | typeof API_PUBLIC_ORCHESTRATION_PATH;

// SkillHub actions (WebsitePortal) — search plus the two install-side actions.
export const API_ACTION_SEARCH_HUB = 'SearchHub';
export const API_ACTION_GET_HUB_SKILL = 'GetHubSkill';
export const API_ACTION_GET_HUB_SKILL_DOWNLOAD = 'GetHubSkillDownload';

// Pack actions (WebsitePortal) — skill collection download.
export const API_ACTION_HUB_COLLECTION_DOWNLOAD = 'HubSkillCollectionDownload';

// Products with optional authentication (public search API, etc.)
export const AUTH_OPTIONAL_PRODUCTS: ReadonlySet<string> = new Set([API_PRODUCT_SEARCH]);
