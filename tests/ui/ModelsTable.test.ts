import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildModelsViewModel,
  buildModelsUiData,
  MODEL_LIST_COLUMNS,
} from '../../src/ui/ModelsTable.js';
import { renderTextModelsList } from '../../src/output/text/models.js';
import type { Model, ModelDetail } from '../../src/types/model.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('MODEL_LIST_COLUMNS', () => {
  it('exports 8 column definitions with split fields', () => {
    expect(MODEL_LIST_COLUMNS).toHaveLength(8);
    expect(MODEL_LIST_COLUMNS.map(c => c.key)).toEqual([
      'id', 'modalityInput', 'modalityOutput',
      'freeTierAmt', 'freeTierUnit', 'freeTierBar',
      'price', 'priceUnit',
    ]);
    expect(MODEL_LIST_COLUMNS[0].color).toBeDefined();
    expect(MODEL_LIST_COLUMNS[3].align).toBe('right'); // freeTierAmt
    expect(MODEL_LIST_COLUMNS[6].align).toBe('right'); // price
  });
});

describe('buildModelsViewModel (pure ViewModel)', () => {
  const mockModels = [
    {
      id: 'qwen3.6-plus',
      modality: { input: ['text', 'image'], output: ['text'] },
      can_try: true,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 850000, total: 1000000, unit: 'tokens', used_pct: 15, status: 'valid' },
      },
      pricing: {
        tiers: [
          { label: '≤ 256K', input: 0.50, output: 3.00, unit: 'USD/1M tokens' },
        ],
      },
    },
    {
      id: 'qwen3.5-omni-plus',
      modality: { input: ['text', 'audio'], output: ['text', 'audio'] },
      can_try: true,
      free_tier: { mode: 'only', quota: null },
    },
    {
      id: 'wan2.6-t2i',
      modality: { input: ['text'], output: ['image'] },
      can_try: false,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 38, total: 50, unit: 'images', used_pct: 24, status: 'valid' },
      },
      pricing: { per_image: { price: 0.03, unit: 'USD/image' } },
    },
  ] as unknown as Model[];

  it('builds view model with split fields', () => {
    const vm = buildModelsViewModel(mockModels);

    expect(vm.total).toBe(3);
    expect(vm.rows).toHaveLength(3);

    expect(vm.rows[0].id).toBe('qwen3.6-plus');
    expect(vm.rows[0].modalityInput).toBe('Text+Img');
    expect(vm.rows[0].modalityOutput).toBe('Text');
    expect(vm.rows[0].freeTierAmt).toBe('1M');
    expect(vm.rows[0].freeTierUnit).toBe('tok');
    expect(vm.rows[0].freeTierRemainingPct).toBe(85);
    expect(vm.rows[0].canTry).toBe('Yes');
    // Single tier: "${s.currencySymbol}0.50 / ${s.currencySymbol}3.00" amount split (no ' /' inside the input/output price)
    expect(vm.rows[0].price).toBe(`${s.currencySymbol}0.50 / ${s.currencySymbol}3.00`);
    expect(vm.rows[0].priceUnit).toBe('/1M tok');

    expect(vm.rows[1].id).toBe('qwen3.5-omni-plus');
    expect(vm.rows[1].freeTierAmt).toBe('Only');
    expect(vm.rows[1].freeTierUnit).toBe('');
    expect(vm.rows[1].canTry).toBe('Yes');
    expect(vm.rows[1].price).toBe('—');
    expect(vm.rows[1].priceUnit).toBe('');

    expect(vm.rows[2].id).toBe('wan2.6-t2i');
    expect(vm.rows[2].freeTierAmt).toBe('50');
    expect(vm.rows[2].freeTierUnit).toBe('img');
    expect(vm.rows[2].canTry).toBe('No');
    expect(vm.rows[2].price).toBe(`${s.currencySymbol}0.03`);
    expect(vm.rows[2].priceUnit).toBe('/img');
  });

  it('handles empty models list', () => {
    const vm = buildModelsViewModel([]);
    expect(vm.rows).toEqual([]);
    expect(vm.total).toBe(0);
  });

  it('handles models without pricing', () => {
    const models = [
      {
        id: 'no-pricing-model',
        modality: { input: ['text'], output: ['text'] },
        can_try: false,
        free_tier: { mode: null, quota: null },
      },
    ] as unknown as Model[];
    const vm = buildModelsViewModel(models);
    expect(vm.rows[0].price).toBe('—');
    expect(vm.rows[0].priceUnit).toBe('');
    expect(vm.rows[0].freeTierAmt).toBe('—');
    expect(vm.rows[0].freeTierUnit).toBe('');
  });
});

describe('buildModelsUiData (UI data with progress bar)', () => {
  const mockModels = [
    {
      id: 'qwen3.6-plus',
      modality: { input: ['text', 'image'], output: ['text'] },
      can_try: true,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 850000, total: 1000000, unit: 'tokens', used_pct: 15, status: 'valid' },
      },
      pricing: {
        tiers: [
          { label: '≤ 256K', input: 0.50, output: 3.00, unit: 'USD/1M tokens' },
        ],
      },
    },
    {
      id: 'qwen3.5-omni-plus',
      modality: { input: ['text', 'audio'], output: ['text', 'audio'] },
      can_try: true,
      free_tier: { mode: 'only', quota: null },
    },
    {
      id: 'wan2.6-t2i',
      modality: { input: ['text'], output: ['image'] },
      can_try: false,
      free_tier: {
        mode: 'standard',
        quota: { remaining: 0, total: 50, unit: 'images', used_pct: 100, status: 'exhaust' },
      },
      pricing: { per_image: { price: 0.03, unit: 'USD/image' } },
    },
  ] as unknown as Model[];

  it('builds UI data with progress bar', () => {
    const uiData = buildModelsUiData(mockModels);

    expect(uiData.total).toBe(3);
    expect(uiData.rows).toHaveLength(3);
    expect(uiData.hasQuota).toBe(true);

    // First row: 85% remaining, progress bar should be non-empty
    expect(uiData.rows[0].freeTierAmt).toBe('1M');
    expect(uiData.rows[0].freeTierBar).toContain('█');
    expect(uiData.rows[0].freeTierBar).toContain('85.0%');

    // Second row: "Only" mode, no quota → empty bar
    expect(uiData.rows[1].freeTierAmt).toBe('Only');
    expect(uiData.rows[1].freeTierBar).toBe('');

    // Third row: exhaust → bar should show 0%
    expect(uiData.rows[2].freeTierAmt).toBe('50');
    expect(uiData.rows[2].freeTierBar).toContain('0.0%');
  });

  it('handles empty models list', () => {
    const uiData = buildModelsUiData([]);
    expect(uiData.rows).toEqual([]);
    expect(uiData.total).toBe(0);
    expect(uiData.hasQuota).toBe(false);
  });

  it('handles models without pricing', () => {
    const models = [
      {
        id: 'no-pricing-model',
        modality: { input: ['text'], output: ['text'] },
        can_try: false,
        free_tier: { mode: null, quota: null },
      },
    ] as unknown as Model[];
    const uiData = buildModelsUiData(models);
    expect(uiData.rows[0].price).toBe('—');
    expect(uiData.rows[0].freeTierAmt).toBe('—');
    expect(uiData.rows[0].freeTierBar).toBe('');
    expect(uiData.hasQuota).toBe(false);
  });

  it('builds view model with details (pricing override)', () => {
    const details = [
      {
        ...mockModels[0],
        description: 'Test model',
        tags: ['test'],
        features: [],
        pricing: {
          tiers: [
            { label: '≤ 128K', input: 0.25, output: 1.50, unit: 'USD/1M tokens' },
            { label: '128K – 1M', input: 1.00, output: 4.00, unit: 'USD/1M tokens' },
          ],
        },
        context: { context_window: 128000 },
        rate_limits: { rpm: 10000 },
        metadata: { version_tag: 'v1', open_source: true, updated: '2026-01-01' },
      },
      null,
      null,
    ] as unknown as (ModelDetail | null)[];

    const uiData = buildModelsUiData(mockModels, details);

    // First row should use detail pricing (cheapest tier + " +" suffix for multi-tier)
    expect(uiData.rows[0].price).toContain(`${s.currencySymbol}0.25`);
    expect(uiData.rows[0].price).toContain('+');
    // Other rows should use model pricing
    expect(uiData.rows[1].price).toBe('—');
    expect(uiData.rows[2].price).toBe(`${s.currencySymbol}0.03`);
  });

  it('handles multi-tier pricing correctly', () => {
    const models = [
      {
        id: 'multi-tier',
        modality: { input: ['text'], output: ['text'] },
        can_try: true,
        free_tier: {
          mode: 'standard',
          quota: { remaining: 500000, total: 1000000, unit: 'tokens', used_pct: 50, status: 'valid' },
        },
        pricing: {
          tiers: [
            { label: '≤ 128K', input: 0.10, output: 0.50, unit: 'USD/1M' },
            { label: '128K – 512K', input: 0.50, output: 1.50, unit: 'USD/1M' },
            { label: '512K+', input: 2.00, output: 6.00, unit: 'USD/1M' },
          ],
        },
      },
    ] as unknown as Model[];
    const uiData = buildModelsUiData(models);
    // Shows cheapest tier with "+" for multi-tier
    expect(uiData.rows[0].price).toContain(`${s.currencySymbol}0.10`);
    expect(uiData.rows[0].price).toContain('+');
    expect(uiData.rows[0].freeTierBar).toContain('50.0%');
  });

  it('handles video per-second pricing', () => {
    const models = [
      {
        id: 'video-model',
        modality: { input: ['text'], output: ['video'] },
        can_try: true,
        free_tier: {
          mode: 'standard',
          quota: { remaining: 100, total: 100, unit: 'seconds', used_pct: 0, status: 'valid' },
        },
        pricing: {
          per_second: [
            { resolution: '720p', price: 0.02, unit: 'USD/sec' },
            { resolution: '1080p', price: 0.05, unit: 'USD/sec' },
          ],
        },
      },
    ] as unknown as Model[];
    const uiData = buildModelsUiData(models);
    expect(uiData.rows[0].price).toContain(`${s.currencySymbol}0.02`);
    expect(uiData.rows[0].freeTierAmt).toBe('100');
    expect(uiData.rows[0].freeTierUnit).toBe('sec');
    expect(uiData.rows[0].freeTierBar).toContain('100.0%');
  });

  it('handles TTS pricing', () => {
    const models = [
      {
        id: 'tts-model',
        modality: { input: ['text'], output: ['audio'] },
        can_try: false,
        free_tier: { mode: null, quota: null },
        pricing: { per_character: { price: 0.01, unit: 'USD/10K chars' } },
      },
    ] as unknown as Model[];
    const uiData = buildModelsUiData(models);
    expect(uiData.rows[0].price).toBe(`${s.currencySymbol}0.01`);
    expect(uiData.rows[0].priceUnit).toBe('/10K char');
  });

  it('handles ASR pricing', () => {
    const models = [
      {
        id: 'asr-model',
        modality: { input: ['audio'], output: ['text'] },
        can_try: true,
        free_tier: { mode: null, quota: null },
        pricing: { per_second_audio: { price: 0.00045, unit: 'USD/sec' } },
      },
    ] as unknown as Model[];
    const uiData = buildModelsUiData(models);
    expect(uiData.rows[0].price).toBe(`${s.currencySymbol}0.00045`);
    expect(uiData.rows[0].priceUnit).toBe('/sec');
  });

  it('handles embedding pricing', () => {
    const models = [
      {
        id: 'embedding-model',
        modality: { input: ['text'], output: ['vector'] },
        can_try: false,
        free_tier: { mode: null, quota: null },
        pricing: { per_token: { price: 0.10, unit: 'USD/1M tokens' } },
      },
    ] as unknown as Model[];
    const uiData = buildModelsUiData(models);
    expect(uiData.rows[0].price).toBe(`${s.currencySymbol}0.10`);
    expect(uiData.rows[0].priceUnit).toBe('/1M tok');
  });

  it('detects all-zero tiers as free', () => {
    const models = [
      {
        id: 'free-model',
        modality: { input: ['text'], output: ['text'] },
        can_try: true,
        free_tier: {
          mode: 'standard',
          quota: { remaining: 1000000, total: 1000000, unit: 'tokens', used_pct: 0, status: 'valid' },
        },
        pricing: {
          tiers: [
            { label: 'Free tier', input: 0, output: 0, unit: 'USD/1M' },
          ],
        },
      },
    ] as unknown as Model[];
    const uiData = buildModelsUiData(models);
    expect(uiData.rows[0].price).toBe('Free');
  });
});

describe('renderTextModelsList', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('renders text table with new columns', () => {
    const vm = buildModelsViewModel([
      {
        id: 'test-model',
        modality: { input: ['text'], output: ['text'] },
        can_try: true,
        free_tier: { mode: 'only', quota: null },
      },
    ]);

    renderTextModelsList(vm);

    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    const tableOutput = consoleLogSpy.mock.calls[0][0];
    expect(tableOutput).toContain('Model ID');
    expect(tableOutput).toContain('Input');
    expect(tableOutput).toContain('Output');
    expect(tableOutput).toContain('test-model');
    expect(tableOutput).toContain('Only');

    const footerOutput = consoleLogSpy.mock.calls[1][0];
    expect(footerOutput).toContain('1 models');
  });

  it('renders empty table', () => {
    const vm = buildModelsViewModel([]);
    renderTextModelsList(vm);

    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    const tableOutput = consoleLogSpy.mock.calls[0][0];
    expect(tableOutput).toContain('Model ID');
    const footerOutput = consoleLogSpy.mock.calls[1][0];
    expect(footerOutput).toContain('0 models');
  });
});
