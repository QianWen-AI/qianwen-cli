import type { ConfigKey, ConfigSchema } from '../types/config.js';
import { site } from '../site.js';

/**
 * Default values for all config keys.
 */
export const CONFIG_DEFAULTS: ConfigSchema = {
  'output.format': 'auto',
  'api.endpoint': site.apiEndpoint,
  'auth.endpoint': site.authEndpoint,
};

/**
 * All valid config keys (including internal ones).
 */
export const VALID_KEYS: ConfigKey[] = Object.keys(CONFIG_DEFAULTS) as ConfigKey[];

/**
 * User-visible config keys (excludes internal keys like api.endpoint, auth.endpoint).
 */
export const PUBLIC_KEYS: ConfigKey[] = ['output.format'] as ConfigKey[];

/**
 * Check if a key is a valid config key (internal use).
 */
export function isValidKey(key: string): key is ConfigKey {
  return VALID_KEYS.includes(key as ConfigKey);
}

/**
 * Check if a key is a user-visible (public) config key.
 */
export function isPublicKey(key: string): key is ConfigKey {
  return PUBLIC_KEYS.includes(key as ConfigKey);
}

/**
 * Validation rules per key.
 */
const VALIDATORS: Record<ConfigKey, (value: string) => boolean> = {
  'output.format': (v) => ['auto', 'table', 'json', 'text'].includes(v),
  'api.endpoint': (v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  },
  'auth.endpoint': (v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Validate a config value for a given key.
 * Returns null if valid, error message if invalid.
 */
export function validateConfigValue(key: ConfigKey, value: string): string | null {
  const validator = VALIDATORS[key];
  if (!validator) return null;

  if (!validator(value)) {
    switch (key) {
      case 'output.format':
        return `Invalid value for output.format. Allowed: auto, table, json, text`;
      case 'api.endpoint':
        return `Invalid value for api.endpoint. Must be a valid URL`;
      case 'auth.endpoint':
        return `Invalid value for auth.endpoint. Must be a valid URL`;
      default:
        return `Invalid value for ${key}`;
    }
  }

  return null;
}
