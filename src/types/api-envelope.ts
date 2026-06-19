/**
 * Raw API response envelope from the CLI gateway.
 * Raw API response envelope structure.
 */
export interface RawApiEnvelope<T = unknown> {
  code: string;
  data?: T;
  message?: string | null;
  requestId?: string;
  httpStatusCode?: string;
  successResponse?: boolean;
}

/**
 * Nested response structure for certain endpoints.
 * Real wire format: DataV2.ret at the DataV2 level,
 * business payload at DataV2.data.data.
 */
export interface GatewayEnvelope<T = unknown> {
  DataV2?: {
    ret?: string[];
    data?: {
      data?: T;
      success?: boolean;
      code?: string | number;
      message?: string;
      failed?: boolean;
      requestId?: string;
      httpStatusCode?: number;
    };
  };
}
