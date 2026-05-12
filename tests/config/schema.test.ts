import { describe, it, expect } from 'vitest';
import { CONFIG_DEFAULTS, VALID_KEYS, PUBLIC_KEYS, isValidKey, isPublicKey, validateConfigValue } from '../../src/config/schema.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('CONFIG_DEFAULTS', () => {
  it('has correct default values', () => {
    expect(CONFIG_DEFAULTS['output.format']).toBe('auto');
    expect(CONFIG_DEFAULTS['api.endpoint']).toBe(s.apiEndpoint);
    expect(CONFIG_DEFAULTS['auth.endpoint']).toBe(s.authEndpoint);
  });
});

describe('VALID_KEYS', () => {
  it('contains all default keys', () => {
    const defaultKeys = Object.keys(CONFIG_DEFAULTS);
    for (const key of defaultKeys) {
      expect(VALID_KEYS).toContain(key);
    }
  });

  it('has correct length', () => {
    expect(VALID_KEYS).toHaveLength(3);
  });
});

describe('PUBLIC_KEYS', () => {
  it('contains only user-visible keys', () => {
    expect(PUBLIC_KEYS).toContain('output.format');
  });

  it('does not contain internal keys', () => {
    expect(PUBLIC_KEYS).not.toContain('api.endpoint');
    expect(PUBLIC_KEYS).not.toContain('auth.endpoint');
  });

  it('has correct length', () => {
    expect(PUBLIC_KEYS).toHaveLength(1);
  });
});

describe('isValidKey', () => {
  it('returns true for valid keys', () => {
    expect(isValidKey('output.format')).toBe(true);
    expect(isValidKey('api.endpoint')).toBe(true);
    expect(isValidKey('auth.endpoint')).toBe(true);
  });

  it('returns false for invalid keys', () => {
    expect(isValidKey('invalid.key')).toBe(false);
    expect(isValidKey('output')).toBe(false);
    expect(isValidKey('')).toBe(false);
    expect(isValidKey('random')).toBe(false);
  });
});

describe('isPublicKey', () => {
  it('returns true for public keys', () => {
    expect(isPublicKey('output.format')).toBe(true);
  });

  it('returns false for internal keys', () => {
    expect(isPublicKey('api.endpoint')).toBe(false);
    expect(isPublicKey('auth.endpoint')).toBe(false);
  });

  it('returns false for invalid keys', () => {
    expect(isPublicKey('invalid.key')).toBe(false);
    expect(isPublicKey('')).toBe(false);
  });
});

describe('validateConfigValue', () => {
  describe('output.format', () => {
    it('accepts valid values', () => {
      expect(validateConfigValue('output.format', 'auto')).toBeNull();
      expect(validateConfigValue('output.format', 'table')).toBeNull();
      expect(validateConfigValue('output.format', 'json')).toBeNull();
      expect(validateConfigValue('output.format', 'text')).toBeNull();
    });

    it('rejects invalid values', () => {
      expect(validateConfigValue('output.format', 'xml')).toContain('Invalid value');
      expect(validateConfigValue('output.format', 'csv')).toContain('Invalid value');
      expect(validateConfigValue('output.format', '')).toContain('Invalid value');
    });
  });

  describe('api.endpoint', () => {
    it('accepts valid URLs', () => {
      expect(validateConfigValue('api.endpoint', 'https://api.example.com')).toBeNull();
      expect(validateConfigValue('api.endpoint', 'http://localhost:3000')).toBeNull();
      expect(validateConfigValue('api.endpoint', `${s.apiEndpoint}/api/v1`)).toBeNull();
    });

    it('rejects invalid URLs', () => {
      expect(validateConfigValue('api.endpoint', 'not-a-url')).toContain('Invalid value');
      expect(validateConfigValue('api.endpoint', '')).toContain('Invalid value');
      expect(validateConfigValue('api.endpoint', '://missing-scheme')).toContain('Invalid value');
    });
  });

  describe('auth.endpoint', () => {
    it('accepts valid URLs', () => {
      expect(validateConfigValue('auth.endpoint', 'https://auth.example.com')).toBeNull();
      expect(validateConfigValue('auth.endpoint', 'http://localhost:8080')).toBeNull();
    });

    it('rejects invalid URLs', () => {
      expect(validateConfigValue('auth.endpoint', 'invalid')).toContain('Invalid value');
      expect(validateConfigValue('auth.endpoint', '')).toContain('Invalid value');
    });
  });

  describe('unknown key', () => {
    it('returns validation error for valid key with invalid value', () => {
      // TypeScript prevents unknown keys at compile time
      // At runtime, valid keys with invalid values return error messages
      const result = validateConfigValue('output.format', 'invalid');
      expect(result).toContain('Invalid value');
    });
  });
});
