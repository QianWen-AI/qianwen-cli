import { describe, it, expect } from 'vitest';
import {
  splitPrice,
  formatFreeTier,
  formatPriceFromPricing,
} from '../../src/utils/formatting.js';
import { formatFreeTierSplit } from '../../src/view-models/models.js';
import type { Model, Pricing } from '../../src/types/model.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('splitPrice', () => {
  it('splits price with unit', () => {
    expect(splitPrice(`${s.currencySymbol}0.50 /1M tok`)).toEqual({ amount: `${s.currencySymbol}0.50`, unit: '/1M tok' });
    expect(splitPrice(`${s.currencySymbol}0.03 /img`)).toEqual({ amount: `${s.currencySymbol}0.03`, unit: '/img' });
  });

  it('handles range prices', () => {
    expect(splitPrice(`${s.currencySymbol}0.50-2.00 /1M tok`)).toEqual({ amount: `${s.currencySymbol}0.50-2.00`, unit: '/1M tok' });
  });

  it('handles input/output separator in price', () => {
    // "${s.currencySymbol}0.10 / ${s.currencySymbol}0.40 /1M tok" should split at LAST ' /'
    expect(splitPrice(`${s.currencySymbol}0.10 / ${s.currencySymbol}0.40 /1M tok`)).toEqual({ amount: `${s.currencySymbol}0.10 / ${s.currencySymbol}0.40`, unit: '/1M tok' });
  });

  it('returns empty unit for Free and dash', () => {
    expect(splitPrice('Free')).toEqual({ amount: 'Free', unit: '' });
    expect(splitPrice('—')).toEqual({ amount: '—', unit: '' });
  });

  it('handles price without separator', () => {
    expect(splitPrice(`${s.currencySymbol}0.05`)).toEqual({ amount: `${s.currencySymbol}0.05`, unit: '' });
  });
});

describe('formatFreeTierSplit', () => {
  const baseModel: Model = {
    id: 'test',
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: { mode: 'standard', quota: null },
  };

  it('returns Only for mode=only', () => {
    const model: Model = { ...baseModel, free_tier: { mode: 'only', quota: null } };
    expect(formatFreeTierSplit(model)).toEqual({ amount: 'Only', unit: '' });
  });

  it('formats standard quota correctly', () => {
    const model: Model = {
      ...baseModel,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 1000000, total: 1000000, unit: 'tokens', used_pct: 0 },
      },
    };
    expect(formatFreeTierSplit(model)).toEqual({ amount: '1M', unit: 'tok' });
  });

  it('handles image quotas', () => {
    const model: Model = {
      ...baseModel,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 50, total: 50, unit: 'images', used_pct: 0 },
      },
    };
    expect(formatFreeTierSplit(model)).toEqual({ amount: '50', unit: 'img' });
  });

  it('handles second-based quotas', () => {
    const model: Model = {
      ...baseModel,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 100, total: 100, unit: 'seconds', used_pct: 0 },
      },
    };
    expect(formatFreeTierSplit(model)).toEqual({ amount: '100', unit: 'sec' });
  });

  it('handles character-based quotas', () => {
    const model: Model = {
      ...baseModel,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 10000, total: 10000, unit: 'characters', used_pct: 0 },
      },
    };
    expect(formatFreeTierSplit(model)).toEqual({ amount: '10K', unit: 'char' });
  });

  it('returns dash for standard mode without quota', () => {
    const model: Model = { ...baseModel, free_tier: { mode: 'standard', quota: null } };
    expect(formatFreeTierSplit(model)).toEqual({ amount: '—', unit: '' });
  });

  it('returns dash for null mode', () => {
    const model = { ...baseModel, free_tier: { mode: null, quota: null } };
    expect(formatFreeTierSplit(model)).toEqual({ amount: '—', unit: '' });
  });

  // NOTE: this exercises the view-models version of formatFreeTierSplit
  // (the one actually used by commands/models). It keeps the numeric amount
  // and adds an `expired: true` flag plus a "(expired)" suffix on the unit,
  // unlike the older utils/formatting.ts version (which is unused).
  it('keeps numeric amount but flags expired quotas with suffix + expired:true', () => {
    const model: Model = {
      ...baseModel,
      free_tier: {
        mode: 'standard',
        quota: {
          remaining: 0,
          total: 1000,
          unit: 'tokens',
          used_pct: 100,
          status: 'expire',
        },
      },
    };
    expect(formatFreeTierSplit(model)).toEqual({
      amount: '1K',
      unit: 'tok (expired)',
      expired: true,
    });
  });
});

describe('formatFreeTier', () => {
  const baseModel: Model = {
    id: 'test',
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: { mode: 'standard', quota: null },
  };

  it('returns "Only" for free-only models', () => {
    const model: Model = { ...baseModel, free_tier: { mode: 'only', quota: null } };
    expect(formatFreeTier(model)).toBe('Only');
  });

  it('formats standard quota with remaining tokens via humanize', () => {
    const model: Model = {
      ...baseModel,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 500_000, total: 1_000_000, unit: 'tokens', used_pct: 50 },
      },
    };
    // humanizeWithUnit produces "500K tokens" for 500_000 tokens
    expect(formatFreeTier(model)).toMatch(/500K/);
  });

  it('appends "(exhaust)" when quota status is exhaust', () => {
    const model: Model = {
      ...baseModel,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 0, total: 1000, unit: 'tokens', used_pct: 100, status: 'exhaust' },
      },
    };
    expect(formatFreeTier(model)).toMatch(/\(exhaust\)$/);
  });

  it('appends "(expired)" when quota status is expire', () => {
    const model: Model = {
      ...baseModel,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 100, total: 1000, unit: 'tokens', used_pct: 90, status: 'expire' },
      },
    };
    expect(formatFreeTier(model)).toMatch(/\(expired\)$/);
  });

  it('returns "Yes" for standard mode with no quota detail', () => {
    const model: Model = { ...baseModel, free_tier: { mode: 'standard', quota: null } };
    expect(formatFreeTier(model)).toBe('Yes');
  });

  it('returns em-dash for null mode', () => {
    const model = { ...baseModel, free_tier: { mode: null, quota: null } } as Model;
    expect(formatFreeTier(model)).toBe('\u2014');
  });
});

describe('formatPriceFromPricing', () => {
  it('returns "Free" when isFreeOnly flag is set', () => {
    const pricing: Pricing = { tiers: [{ label: '0-128k', input: 1, output: 2, unit: '/1M tok' }] };
    expect(formatPriceFromPricing(pricing, true)).toBe('Free');
  });

  it('returns em-dash for empty LLM tiers', () => {
    expect(formatPriceFromPricing({ tiers: [] }, false)).toBe('\u2014');
  });

  it('returns "Free" when all LLM tiers are zero-priced', () => {
    const pricing: Pricing = {
      tiers: [
        { label: '0-128k', input: 0, output: 0, unit: '/1M tok' },
        { label: '128k+', input: 0, output: 0, unit: '/1M tok' },
      ],
    };
    expect(formatPriceFromPricing(pricing, false)).toBe('Free');
  });

  it('formats single-tier LLM pricing', () => {
    const pricing: Pricing = {
      tiers: [{ label: 'std', input: 0.5, output: 2, unit: `/${s.currency}/1M tok` }],
    };
    expect(formatPriceFromPricing(pricing, false)).toBe(`${s.currencySymbol}0.50 / ${s.currencySymbol}2.00 /1M tok`);
  });

  it('marks multi-tier LLM pricing with "+" suffix and uses cheapest input', () => {
    const pricing: Pricing = {
      tiers: [
        { label: '0-128k', input: 0.8, output: 4, unit: `/${s.currency}/1M tok` },
        { label: '128k-256k', input: 1.6, output: 8, unit: `/${s.currency}/1M tok` },
      ],
    };
    expect(formatPriceFromPricing(pricing, false)).toBe(`${s.currencySymbol}0.80 / ${s.currencySymbol}4.00 + /1M tok`);
  });

  it('formats per_second video pricing — single resolution', () => {
    const pricing: Pricing = {
      per_second: [{ resolution: '720p', price: 0.25, unit: `/${s.currency}/sec` }],
    };
    expect(formatPriceFromPricing(pricing, false)).toBe(`${s.currencySymbol}0.25 /sec`);
  });

  it('formats per_second video pricing — multi-resolution as range', () => {
    const pricing: Pricing = {
      per_second: [
        { resolution: '480p', price: 0.1, unit: `/${s.currency}/sec` },
        { resolution: '720p', price: 0.25, unit: `/${s.currency}/sec` },
        { resolution: '1080p', price: 0.5, unit: `/${s.currency}/sec` },
      ],
    };
    expect(formatPriceFromPricing(pricing, false)).toBe(`${s.currencySymbol}0.10-0.50 /sec`);
  });

  it('formats per_image pricing', () => {
    const pricing: Pricing = { per_image: { price: 0.04, unit: `/${s.currency}/img` } };
    expect(formatPriceFromPricing(pricing, false)).toBe(`${s.currencySymbol}0.04 /img`);
  });

  it('formats per_character (TTS) pricing', () => {
    const pricing: Pricing = { per_character: { price: 0.7, unit: `/${s.currency}/10K char` } };
    expect(formatPriceFromPricing(pricing, false)).toBe(`${s.currencySymbol}0.70 /10K char`);
  });

  it('formats per_second_audio (ASR) pricing with 5-digit precision', () => {
    const pricing: Pricing = { per_second_audio: { price: 0.00012, unit: `/${s.currency}/sec` } };
    expect(formatPriceFromPricing(pricing, false)).toBe(`${s.currencySymbol}0.00012 /sec`);
  });

  it('formats per_token (embedding) pricing', () => {
    const pricing: Pricing = { per_token: { price: 0.05, unit: `/${s.currency}/1M tok` } };
    expect(formatPriceFromPricing(pricing, false)).toBe(`${s.currencySymbol}0.05 /1M tok`);
  });
});
