import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildModelDetailViewModel } from '../../src/view-models/models.js';
import { renderTextModelDetail } from '../../src/output/text/models.js';
import type { ModelDetail } from '../../src/types/model.js';

describe('renderTextModelDetail - Free Tier', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  const baseDetail: ModelDetail = {
    id: 'test-model',
    description: 'Test model',
    tags: ['test'],
    modality: { input: ['text'], output: ['text'] },
    features: [],
    can_try: true,
    free_tier: {
      mode: 'standard',
      quota: { remaining: 850000, total: 1000000, unit: 'tokens', used_pct: 15, resetDate: '2026-05-01' },
    },
    pricing: { tiers: [{ label: 'Default', input: 0.50, output: 1.00, unit: 'USD/1M tokens' }] },
    context: { context_window: 128000 },
    rate_limits: { rpm: 10000 },
    metadata: { version_tag: 'v1', open_source: true, updated: '2026-01-01' },
  };

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('renders structured free tier with quota data', () => {
    const vm = buildModelDetailViewModel(baseDetail);
    renderTextModelDetail(vm);

    const output = consoleLogSpy.mock.calls.join('\n');
    expect(output).toContain('Free Tier');
    expect(output).toContain('1M tok');
    expect(output).toContain('850K tok');
    expect(output).toContain('85%');
    expect(output).toContain('2026-05-01');
  });

  it('renders "only" mode free tier', () => {
    const detail = { ...baseDetail, free_tier: { mode: 'only' as const, quota: null } };
    const vm = buildModelDetailViewModel(detail);
    renderTextModelDetail(vm);

    const output = consoleLogSpy.mock.calls.join('\n');
    expect(output).toContain('Free (Early Access)');
    expect(output).toContain('no paid option');
  });

  it('renders unavailable message when quota data missing', () => {
    const detail = { ...baseDetail, free_tier: { mode: 'standard' as const, quota: null } };
    const vm = buildModelDetailViewModel(detail);
    renderTextModelDetail(vm);

    const output = consoleLogSpy.mock.calls.join('\n');
    expect(output).toContain('Quota data unavailable');
  });
});
