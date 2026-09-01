export interface ConfigSchema {
  'output.format': 'auto' | 'table' | 'json' | 'text';
  'api.endpoint': string;
  'auth.endpoint': string; // Auth API base URL
  'cache.ttl': string; // File cache TTL in milliseconds. '0' disables file cache. Hidden from `config list`.
  'support.categorySource': string; // Support category-tree source: '' = embedded local, http(s) URL = CDN fetch, 'cli-api' = Workorder gateway. Hidden from `config list`.
  'model.endpoint': string; // Model-inference base URL or preset name
  'model.api_key': string; // Model-inference API key fallback
}

export type ConfigKey = keyof ConfigSchema;

export type OutputFormat = 'auto' | 'table' | 'json' | 'text';
export type ResolvedFormat = 'table' | 'json' | 'text'; // after auto resolution

export interface ConfigEntry {
  key: ConfigKey;
  value: string;
  source: 'global' | 'default';
  sourcePath?: string;
}
