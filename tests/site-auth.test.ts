/**
 * Site-level authentication metadata used by the credential resolver to build
 * the tier list and the missing-key guidance message. These fields are the
 * single source of truth for the per-site env aliases and the console URL, so
 * the resolver stays site-agnostic.
 */
import { describe, it, expect } from 'vitest';
import { site } from '../src/site.js';

describe('site authentication metadata', () => {
  it('exposes the API-key console URL per specification', () => {
    expect(site.apiKeyConsoleUrl).toBe('https://platform.qianwenai.com/home/api-keys');
  });

  it('does not list a private env alias (qianwen: primary + generic only)', () => {
    expect(site.apiKeyEnvAliases).not.toContain('QWEN_API_KEY');
    expect(site.apiKeyEnvAliases).not.toContain(`${site.envPrefix}_API_KEY`);
    expect(site.apiKeyEnvAliases).not.toContain('DASHSCOPE_API_KEY');
  });
});
