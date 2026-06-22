export type RouteType = 'A' | 'B';

// Product constants (used across API routing layers)
export const API_PRODUCT_ACCOUNT_CENTER = 'AccountCenter';
export const API_PRODUCT_DELIVERY = 'AliyunDeliveryService';
export const API_PRODUCT_BSS = 'BssOpenAPI-V3';
export const API_PRODUCT_GATEWAY = 'sfm_bailian';
export const API_PRODUCT_SEARCH = 'aliyun-search-maas';

// Action constants
export const API_ACTION_LIST_MODELS = 'ListModelSeries';
export const API_ACTION_DESCRIBE_FQ = 'DescribeFqInstance';
export const API_ACTION_DESCRIBE_FR = 'DescribeFrInstances';
export const API_ACTION_GATEWAY = 'BroadScopeAspnGateway';
export const API_ACTION_CONSUME_SUMMARY = 'MaasListConsumeSummary';
export const API_ACTION_SEARCH_ALL = 'SearchAll';

// Products with optional authentication (public search API, etc.)
export const AUTH_OPTIONAL_PRODUCTS: ReadonlySet<string> = new Set([API_PRODUCT_SEARCH]);
