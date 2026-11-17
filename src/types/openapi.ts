export interface OpenApiCallOptions {
  product: string;
  action: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}
