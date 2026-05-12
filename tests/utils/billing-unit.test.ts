import { describe, it, expect } from 'vitest';
import { inferBillingUnitFromModel } from '../../src/utils/billing-unit.js';
import type { Model } from '../../src/types/model.js';

function makeModel(overrides: Partial<Model> & { id?: string } = {}): Model {
  return {
    id: 'test-model',
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: { mode: null, quota: null },
    ...overrides,
  } as unknown as Model;
}

describe('inferBillingUnitFromModel', () => {
  describe('priority 1: free_tier.quota.unit', () => {
    it('returns "images" when quota.unit is images', () => {
      const m = makeModel({
        free_tier: { mode: 'standard', quota: { remaining: 0, total: 100, unit: 'images', used_pct: 0 } },
      });
      expect(inferBillingUnitFromModel(m)).toBe('images');
    });

    it('returns "seconds" when quota.unit is seconds', () => {
      const m = makeModel({
        free_tier: { mode: 'standard', quota: { remaining: 0, total: 1000, unit: 'seconds', used_pct: 0 } },
      });
      expect(inferBillingUnitFromModel(m)).toBe('seconds');
    });

    it('returns "characters" when quota.unit is characters', () => {
      const m = makeModel({
        free_tier: { mode: 'standard', quota: { remaining: 0, total: 1000, unit: 'characters', used_pct: 0 } },
      });
      expect(inferBillingUnitFromModel(m)).toBe('characters');
    });

    it('returns "tokens" when quota.unit is tokens', () => {
      const m = makeModel({
        free_tier: { mode: 'standard', quota: { remaining: 0, total: 1000, unit: 'tokens', used_pct: 0 } },
      });
      expect(inferBillingUnitFromModel(m)).toBe('tokens');
    });
  });

  describe('priority 2: pricing structure', () => {
    it('returns "images" for per_image pricing', () => {
      const m = makeModel({
        pricing: { per_image: { price: 0.04, unit: 'USD/image' } } as any,
      });
      expect(inferBillingUnitFromModel(m)).toBe('images');
    });

    it('returns "seconds" for per_second pricing (video)', () => {
      const m = makeModel({
        pricing: { per_second: [{ resolution: '720p', price: 0.1, unit: 'USD/sec' }] } as any,
      });
      expect(inferBillingUnitFromModel(m)).toBe('seconds');
    });

    it('returns "seconds" for per_second_audio pricing (ASR)', () => {
      const m = makeModel({
        pricing: { per_second_audio: { price: 0.001, unit: 'USD/sec' } } as any,
      });
      expect(inferBillingUnitFromModel(m)).toBe('seconds');
    });

    it('returns "characters" for per_character pricing (TTS)', () => {
      const m = makeModel({
        pricing: { per_character: { price: 0.00001, unit: 'USD/char' } } as any,
      });
      expect(inferBillingUnitFromModel(m)).toBe('characters');
    });

    it('returns "tokens" for tiered LLM pricing', () => {
      const m = makeModel({
        pricing: { tiers: [{ label: 'default', input: 0.5, output: 3, unit: 'USD/1M tokens' }] } as any,
      });
      expect(inferBillingUnitFromModel(m)).toBe('tokens');
    });
  });

  describe('priority 3: modality fallback', () => {
    it('returns "images" when output includes image and no other signal', () => {
      const m = makeModel({ modality: { input: ['text'], output: ['image'] } });
      expect(inferBillingUnitFromModel(m)).toBe('images');
    });

    it('returns "seconds" when output includes video', () => {
      const m = makeModel({ modality: { input: ['text'], output: ['video', 'audio'] } });
      expect(inferBillingUnitFromModel(m)).toBe('seconds');
    });

    it('returns "seconds" when output includes audio', () => {
      const m = makeModel({ modality: { input: ['text'], output: ['audio'] } });
      expect(inferBillingUnitFromModel(m)).toBe('seconds');
    });

    it('defaults to "tokens" for text-only output', () => {
      const m = makeModel({ modality: { input: ['text'], output: ['text'] } });
      expect(inferBillingUnitFromModel(m)).toBe('tokens');
    });
  });

  describe('priority order', () => {
    it('quota.unit beats pricing shape (e.g. omni model with audio output but token billing)', () => {
      // qwen3.5-omni-plus: output=[text, audio], quota.unit=tokens, pricing=tiers
      const m = makeModel({
        modality: { input: ['text'], output: ['text', 'audio'] },
        free_tier: { mode: 'standard', quota: { remaining: 0, total: 1000, unit: 'tokens', used_pct: 0 } },
        pricing: { tiers: [{ label: 'default', input: 0.5, output: 3, unit: 'USD/1M tokens' }] } as any,
      });
      expect(inferBillingUnitFromModel(m)).toBe('tokens');
    });

    it('pricing beats modality (audio model billed by characters? edge case)', () => {
      const m = makeModel({
        modality: { input: ['text'], output: ['audio'] },
        free_tier: { mode: null, quota: null },
        pricing: { per_character: { price: 0.001, unit: 'USD/char' } } as any,
      });
      expect(inferBillingUnitFromModel(m)).toBe('characters');
    });
  });
});
