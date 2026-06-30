export type RouteType = 'A' | 'B';

// Product constants (used across API routing layers)
export const API_PRODUCT_ACCOUNT_CENTER = 'AccountCenter';
/** Product identifier for model delivery service. */
export const API_PRODUCT_DELIVERY = 'AliyunDeliveryService';
/** Product identifier for billing service. */
export const API_PRODUCT_BSS = 'BssOpenAPI-V3';
/** Product identifier for gateway service. */
export const API_PRODUCT_GATEWAY = 'sfm_bailian';
export const API_PRODUCT_SEARCH = 'aliyun-search-maas';
/** Product identifier for support ticket service. */
export const API_PRODUCT_WORKORDER = 'Workorder';

// Action constants
export const API_ACTION_LIST_MODELS = 'ListModelSeries';
export const API_ACTION_DESCRIBE_FQ = 'DescribeFqInstance';
export const API_ACTION_DESCRIBE_FR = 'DescribeFrInstances';
export const API_ACTION_GATEWAY = 'BroadScopeAspnGateway';
export const API_ACTION_CONSUME_SUMMARY = 'MaasListConsumeSummary';
export const API_ACTION_SEARCH_ALL = 'SearchAll';

export const API_ACTION_GET_FUND_ACCOUNT_BALANCE = 'GetFundAccountAvailableAmount';

// Products with optional authentication (public search API, etc.)
export const AUTH_OPTIONAL_PRODUCTS: ReadonlySet<string> = new Set([API_PRODUCT_SEARCH]);
