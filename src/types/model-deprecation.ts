/** Types for the CDN-hosted model deprecation schedule. */

/** One model's retirement schedule as published on the CDN. */
export interface DeprecationEntry {
  /** Model id as sent to the inference endpoint. */
  id: string;
  /** ISO 8601 instant (with offset) after which the model is retired. */
  expiredTime?: string;
}

/** CDN payload: a flat list of retirement schedules. */
export type DeprecationManifest = DeprecationEntry[];
