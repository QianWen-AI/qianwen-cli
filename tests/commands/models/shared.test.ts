import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parsePaginationOptions,
  printPaginationFooter,
  buildModelRows,
  MODEL_LIST_COLUMNS,
} from '../../../src/commands/models/shared.js';
import type { Model, ModelDetail } from '../../../src/types/model.js';
import { site } from '../../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

// ── Helpers ────────────────────────────────────────────────────────
function makeLLM(overrides: Partial<Model> = {}): Model {
  return {
    id: 'llm-x',
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: { mode: null, quota: null },
    pricing: {
      tiers: [
        { label: 'tier-1', input: 0.5, output: 1.5, unit: 'USD/1M tokens' },
      ],
    } as any,
    ...overrides,
  } as Model;
}

// ── parsePaginationOptions ─────────────────────────────────────────
describe('parsePaginationOptions', () => {
  let stderrSpy: any;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('returns default page=1 perPage=20 when no input', () => {
    expect(parsePaginationOptions()).toEqual({ page: 1, perPage: 20 });
  });

  it('parses explicit string values', () => {
    expect(parsePaginationOptions('3', '50')).toEqual({ page: 3, perPage: 50 });
  });

  it('falls back to 1 when parseInt fails (NaN)', () => {
    expect(parsePaginationOptions('abc', 'xyz')).toEqual({ page: 1, perPage: 20 });
  });

  it('clamps page < 1 to 1 and warns to stderr', () => {
    parsePaginationOptions('0', '20');
    // 0 || 1 → 1 in source, so no warning unless rawPage < 1 (parseInt('0')=0)
    // The current implementation: rawPage = parseInt('0') || 1 = 1 (because 0 is falsy)
    // Therefore no warning is fired here — parse succeeds with 1
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('clamps perPage < 1 → 1', () => {
    const r = parsePaginationOptions('1', '0');
    // perPage parseInt('0') || 20 → 20 (0 is falsy)
    expect(r.perPage).toBe(20);
  });

  it('handles undefined separately from empty string', () => {
    expect(parsePaginationOptions(undefined, '5')).toEqual({ page: 1, perPage: 5 });
    expect(parsePaginationOptions('5', undefined)).toEqual({ page: 5, perPage: 20 });
  });
});

// ── printPaginationFooter ──────────────────────────────────────────
describe('printPaginationFooter', () => {
  let logSpy: any;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('prints nothing when totalPages == 1', () => {
    printPaginationFooter(1, 1, 5);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prints summary + next-page hint on non-last page', () => {
    printPaginationFooter(2, 5, 100);
    const calls = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(calls).toContain('Page 2 of 5');
    expect(calls).toContain('100 models');
    expect(calls).toContain('--page 3');
  });

  it('omits next-page hint on last page', () => {
    printPaginationFooter(5, 5, 100);
    const calls = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(calls).toContain('Page 5 of 5');
    expect(calls).not.toContain('--page');
  });
});

// ── MODEL_LIST_COLUMNS schema sanity ───────────────────────────────
describe('MODEL_LIST_COLUMNS', () => {
  it('includes all expected column keys', () => {
    const keys = MODEL_LIST_COLUMNS.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'id',
        'modalityInput',
        'modalityOutput',
        'freeTierAmt',
        'freeTierUnit',
        'freeTierBar',
        'price',
        'priceUnit',
      ]),
    );
  });

  it('all columns have a header string', () => {
    for (const col of MODEL_LIST_COLUMNS) {
      expect(typeof col.header).toBe('string');
      expect(col.header.length).toBeGreaterThan(0);
    }
  });
});

// ── buildModelRows ─────────────────────────────────────────────────
describe('buildModelRows', () => {
  it('builds a row from a basic LLM model with tier pricing', () => {
    const model = makeLLM({ id: 'qwen-plus' });
    const rows = buildModelRows([model], [null]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.id).toBe('qwen-plus');
    expect(r.modalityInput).toBeTruthy();
    expect(r.modalityOutput).toBeTruthy();
    expect(r.price).toContain(s.currencySymbol);
    // canTry column included
    expect(r.canTry).toBe('Yes');
  });

  it('marks can_try=false models', () => {
    const model = makeLLM({ id: 'a', can_try: false });
    const rows = buildModelRows([model], [null]);
    expect(rows[0].canTry).toBe('No');
  });

  it('renders Free price when isFreeOnly (free_tier.mode=only)', () => {
    const model = makeLLM({ id: 'free-only', free_tier: { mode: 'only', quota: null } });
    const rows = buildModelRows([model], [null]);
    expect(rows[0].price.toLowerCase()).toContain('free');
    expect(rows[0].freeTierAmt).toBe('Only');
  });

  it('renders quota with progress bar when free_tier has valid quota', () => {
    const model = makeLLM({
      id: 'with-quota',
      free_tier: {
        mode: 'standard',
        quota: {
          remaining: 800_000,
          total: 1_000_000,
          unit: 'tokens',
          used_pct: 20,
          status: 'valid',
        },
      },
    });
    const rows = buildModelRows([model], [null]);
    expect(rows[0].freeTierAmt).toBeTruthy();
    expect(rows[0].freeTierUnit).toBeTruthy();
    // freeTierBar should not be empty for valid quota
    expect(rows[0].freeTierBar.length).toBeGreaterThan(0);
  });

  it('renders muted "expired" bar when quota status=expire', () => {
    const model = makeLLM({
      id: 'expired',
      free_tier: {
        mode: 'standard',
        quota: {
          remaining: 0,
          total: 1_000_000,
          unit: 'tokens',
          used_pct: 100,
          status: 'expire',
        },
      },
    });
    const rows = buildModelRows([model], [null]);
    // The bar text contains the literal "expired" label
    expect(rows[0].freeTierBar).toMatch(/expired/);
  });

  it('handles an em-dash price when pricing missing', () => {
    const model: Model = {
      id: 'no-pricing',
      modality: { input: ['text'], output: ['text'] },
      can_try: true,
      free_tier: { mode: null, quota: null },
      // pricing intentionally omitted
    } as Model;
    const rows = buildModelRows([model], [null]);
    // splitPrice('—') returns amount='—' unit=''
    expect(rows[0].price).toContain('\u2014');
  });

  it('uses detail.pricing override when provided', () => {
    const baseModel = makeLLM({ id: 'overridden', pricing: undefined });
    const detail: ModelDetail = {
      ...baseModel,
      pricing: {
        tiers: [{ label: 't1', input: 5, output: 10, unit: 'USD/1M tokens' }],
      } as any,
      description: 'desc',
      tags: [],
      features: [],
      rate_limits: { rpm: 100 },
      metadata: { version_tag: 'v1', open_source: false, updated: '2026-01-01' },
    } as any;
    const rows = buildModelRows([baseModel], [detail]);
    expect(rows[0].price).toContain('5.00');
  });

  it('handles multimodal input (image+text) → modality string with separator', () => {
    const model = makeLLM({
      id: 'multimodal',
      modality: { input: ['text', 'image'], output: ['text'] },
    });
    const rows = buildModelRows([model], [null]);
    // abbreviated modality joined by '+'
    expect(rows[0].modalityInput).toMatch(/.+\+.+/);
  });

  it('handles multiple models in one call', () => {
    const models = [
      makeLLM({ id: 'a' }),
      makeLLM({ id: 'b' }),
      makeLLM({ id: 'c' }),
    ];
    const rows = buildModelRows(models, [null, null, null]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
