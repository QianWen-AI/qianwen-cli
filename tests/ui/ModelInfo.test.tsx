import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ModelInfoInk } from '../../src/ui/ModelInfo.js';
import type { ModelDetailViewModel } from '../../src/view-models/models.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

function frame(el: React.ReactElement): string {
  const { lastFrame } = render(el);
  return stripAnsi(lastFrame() ?? '');
}

// ── Test fixtures: minimal ModelDetailViewModel for each pricingType ──
//
// We build VMs directly (rather than running buildModelDetailViewModel) so each
// test isolates a single rendering branch. This keeps failures pointing at the
// presentation layer instead of the upstream view-model.

function baseMetadata() {
  return {
    version: 'MAJOR',
    openSource: 'No',
    updated: '2026-04-01',
  };
}

const ORIGINAL_COLUMNS = process.stdout.columns;
beforeEach(() => {
  // Pin terminal width so column math is deterministic.
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
});
afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: ORIGINAL_COLUMNS, configurable: true });
});

describe('ModelInfoInk', () => {
  it('renders LLM model: header, metadata, modality, pricing table headers', () => {
    const vm: ModelDetailViewModel = {
      id: 'qwen3.6-plus',
      description: 'A flagship LLM.',
      tags: 'Reasoning · Vision',
      modalityInput: 'Text · Img',
      modalityOutput: 'Text',
      features: 'Cache · Tools',
      pricingType: 'llm',
      pricingLines: [
        { cells: { label: '0-128k', input: `${s.currencySymbol}0.50/1M`, output: `${s.currencySymbol}3.00/1M` } },
        { cells: { label: '128k-1M', input: `${s.currencySymbol}2.00/1M`, output: `${s.currencySymbol}6.00/1M` } },
      ],
      builtInTools: [
        { name: 'web_search', price: `${s.currencySymbol}10.00 / 1K calls`, api: 'Responses API' },
      ],
      context: { window: '1M tok', maxInput: '991.8K tok', maxOutput: '65.5K tok' },
      rateLimits: 'RPM   15K          TPM   5M',
      metadata: baseMetadata(),
    };

    const out = frame(<ModelInfoInk vm={vm} />);

    // Card title (model id)
    expect(out).toContain('qwen3.6-plus');
    // Sections
    expect(out).toContain('Metadata');
    expect(out).toContain('Description');
    expect(out).toContain('Tags');
    expect(out).toContain('Modality');
    expect(out).toContain('Pricing');
    expect(out).toContain('Context');
    expect(out).toContain('Rate Limits');
    // LLM pricing table headers
    expect(out).toContain('Tier');
    expect(out).toContain('Input');
    expect(out).toContain('Output');
    // Built-in tools subsection
    expect(out).toContain('Built-in Tools');
    expect(out).toContain('web_search');
    // Description text
    expect(out).toContain('A flagship LLM.');
  });

  it('renders LLM model with cache pricing columns', () => {
    const vm: ModelDetailViewModel = {
      id: 'qwen3.5-plus',
      description: '.',
      tags: '—', // hidden when '—'
      modalityInput: 'Text',
      modalityOutput: 'Text',
      features: '—',
      pricingType: 'llm',
      pricingLines: [
        {
          cells: {
            label: '0-128k',
            input: `${s.currencySymbol}0.50/1M`,
            output: `${s.currencySymbol}3.00/1M`,
            cacheCreation: `${s.currencySymbol}0.63/1M`,
            cacheRead: `${s.currencySymbol}0.05/1M`,
          },
        },
      ],
      builtInTools: [],
      context: { window: '128K tok', maxInput: '120K tok', maxOutput: '8K tok' },
      rateLimits: 'RPM   15K',
      metadata: baseMetadata(),
    };

    const out = frame(<ModelInfoInk vm={vm} />);
    // Cache columns appear when any tier has cache_creation
    expect(out).toContain('Cache Write');
    expect(out).toContain('Cache Read');
    // Tags section omitted when tags === '—'
    expect(out).not.toMatch(/^\s*Tags\s*$/m);
  });

  it('renders all-free LLM as "Free (Early Access)"', () => {
    const vm: ModelDetailViewModel = {
      id: 'free-llm',
      description: 'free',
      tags: '—',
      modalityInput: 'Text',
      modalityOutput: 'Text',
      features: '—',
      pricingType: 'llm',
      pricingLines: [
        { cells: { label: 'all', input: `${s.currencySymbol}0.00/1M`, output: `${s.currencySymbol}0.00/1M` } },
      ],
      builtInTools: [],
      rateLimits: 'RPM   100',
      metadata: baseMetadata(),
    };
    const out = frame(<ModelInfoInk vm={vm} />);
    expect(out).toContain('Free');
    expect(out).toContain('Early Access');
  });

  it('renders image model with single price line', () => {
    const vm: ModelDetailViewModel = {
      id: 'wan2.6-t2i',
      description: 'image gen',
      tags: '—',
      modalityInput: 'Text',
      modalityOutput: 'Img',
      features: '—',
      pricingType: 'image',
      pricingLines: [{ cells: { label: 'Image Generation', price: `${s.currencySymbol}0.03 / image` } }],
      builtInTools: [],
      rateLimits: 'RPM   60',
      metadata: baseMetadata(),
    };
    const out = frame(<ModelInfoInk vm={vm} />);
    expect(out).toContain('Image Generation');
    expect(out).toContain(`${s.currencySymbol}0.03 / image`);
    // No Context section for non-LLM
    expect(out).not.toContain('Context');
  });

  it('renders video model with per-resolution pricing table', () => {
    const vm: ModelDetailViewModel = {
      id: 'wan2.7-r2v',
      description: 'video gen',
      tags: '—',
      modalityInput: 'Text · Img',
      modalityOutput: 'Video',
      features: '—',
      pricingType: 'video',
      pricingLines: [
        { cells: { resolution: '480p', price: `${s.currencySymbol}0.10 / second` } },
        { cells: { resolution: '720p', price: `${s.currencySymbol}0.25 / second` } },
        { cells: { resolution: '1080p', price: `${s.currencySymbol}0.50 / second` } },
      ],
      builtInTools: [],
      rateLimits: 'RPM   30',
      metadata: baseMetadata(),
    };
    const out = frame(<ModelInfoInk vm={vm} />);
    expect(out).toContain('Resolution');
    expect(out).toContain('480p');
    expect(out).toContain('1080p');
    expect(out).toContain(`${s.currencySymbol}0.50 / second`);
  });

  it('renders TTS model with single price line', () => {
    const vm: ModelDetailViewModel = {
      id: 'cosyvoice-v1',
      description: 'tts',
      tags: '—',
      modalityInput: 'Text',
      modalityOutput: 'Audio',
      features: '—',
      pricingType: 'tts',
      pricingLines: [{ cells: { label: 'TTS', price: `${s.currencySymbol}0.70 / 10,000 characters` } }],
      builtInTools: [],
      rateLimits: 'RPM   60',
      metadata: baseMetadata(),
    };
    const out = frame(<ModelInfoInk vm={vm} />);
    expect(out).toContain('TTS');
    expect(out).toContain(`${s.currencySymbol}0.70 / 10,000 characters`);
  });

  it('renders ASR model with single price line', () => {
    const vm: ModelDetailViewModel = {
      id: 'paraformer-v2',
      description: 'asr',
      tags: '—',
      modalityInput: 'Audio',
      modalityOutput: 'Text',
      features: '—',
      pricingType: 'asr',
      pricingLines: [{ cells: { label: 'ASR', price: `${s.currencySymbol}0.00012 / second` } }],
      builtInTools: [],
      rateLimits: 'RPM   30',
      metadata: baseMetadata(),
    };
    const out = frame(<ModelInfoInk vm={vm} />);
    expect(out).toContain('ASR');
    expect(out).toContain(`${s.currencySymbol}0.00012 / second`);
  });

  describe('Free Tier rendering', () => {
    const baseVm: ModelDetailViewModel = {
      id: 'qwen-test',
      description: 'x',
      tags: '—',
      modalityInput: 'Text',
      modalityOutput: 'Text',
      features: '—',
      pricingType: 'image', // simplest pricing branch
      pricingLines: [{ cells: { label: 'Image', price: `${s.currencySymbol}0.03 / image` } }],
      builtInTools: [],
      rateLimits: 'RPM   60',
      metadata: baseMetadata(),
    };

    it('renders "only" free tier with Free + Early Access label', () => {
      const vm: ModelDetailViewModel = { ...baseVm, freeTier: { mode: 'only' } };
      const out = frame(<ModelInfoInk vm={vm} />);
      expect(out).toContain('Free Tier');
      expect(out).toContain('Free');
      expect(out).toContain('Early Access');
    });

    it('renders "standard" free tier with quota: total, remaining bar, reset date', () => {
      const vm: ModelDetailViewModel = {
        ...baseVm,
        freeTier: {
          mode: 'standard',
          total: '1M tok',
          remaining: '850K tok',
          remainingPct: 85,
          resetDate: '2026-05-01',
        },
      };
      const out = frame(<ModelInfoInk vm={vm} />);
      expect(out).toContain('Free Tier');
      expect(out).toContain('Total');
      expect(out).toContain('1M tok');
      expect(out).toContain('Remaining');
      expect(out).toContain('850K tok');
      expect(out).toContain('85.0%');
      expect(out).toContain('Resets');
      expect(out).toContain('2026-05-01');
    });

    it('renders "standard" free tier without quota → unavailable message', () => {
      const vm: ModelDetailViewModel = { ...baseVm, freeTier: { mode: 'standard' } };
      const out = frame(<ModelInfoInk vm={vm} />);
      expect(out).toContain('Quota data unavailable');
    });

    it('shows status label (e.g. "(expired)") in place of percentage when set', () => {
      const vm: ModelDetailViewModel = {
        ...baseVm,
        freeTier: {
          mode: 'standard',
          total: '1M tok',
          remaining: '0 tok',
          remainingPct: 0,
          statusLabel: '(expired)',
        },
      };
      const out = frame(<ModelInfoInk vm={vm} />);
      expect(out).toContain('(expired)');
    });
  });

  it('renders optional metadata fields (category, snapshot) when present', () => {
    const vm: ModelDetailViewModel = {
      id: 'qwen-flagship',
      description: 'x',
      tags: '—',
      modalityInput: 'Text',
      modalityOutput: 'Text',
      features: '—',
      pricingType: 'image',
      pricingLines: [{ cells: { label: 'Image', price: `${s.currencySymbol}0.03 / image` } }],
      builtInTools: [],
      rateLimits: 'RPM   60',
      metadata: {
        category: 'Flagship',
        version: 'MAJOR',
        snapshot: 'v3.6.0',
        openSource: 'Yes',
        updated: '2026-04-01',
      },
    };
    const out = frame(<ModelInfoInk vm={vm} />);
    expect(out).toContain('Category');
    expect(out).toContain('Flagship');
    expect(out).toContain('Snapshot');
    expect(out).toContain('v3.6.0');
    expect(out).toContain('Open Source');
    expect(out).toContain('Yes');
  });

  // ── CJK rendering tests ──────────────────────────────────────────────────

  it('renders CJK description without border misalignment', () => {
    const vm: ModelDetailViewModel = {
      id: 'qianwen-cjk-test',
      description: 'qianwen-cjk-test 是千问云测试用例数据，仅供验证 CJK 排版，无实际业务含义',
      tags: '推理 · 视觉理解',
      modalityInput: 'Text · Img',
      modalityOutput: 'Text',
      features: '—',
      pricingType: 'llm',
      pricingLines: [
        { cells: { label: '标准版', input: `${s.currencySymbol}0.50/1M`, output: `${s.currencySymbol}3.00/1M` } },
      ],
      builtInTools: [],
      rateLimits: 'RPM   15K',
      metadata: baseMetadata(),
    };
    const out = frame(<ModelInfoInk vm={vm} />);
    // Content must be visible
    expect(out).toContain('qianwen-cjk-test');
    expect(out).toContain('标准版');
    // Border must be intact
    expect(out).toContain('┌');
    expect(out).toContain('┐');
    expect(out).toContain('└');
    expect(out).toContain('┘');
  });

  it('renders CJK tier label in pricing table without column misalignment', () => {
    const vm: ModelDetailViewModel = {
      id: 'qianwen-cjk-price',
      description: 'test',
      tags: '—',
      modalityInput: 'Text',
      modalityOutput: 'Text',
      features: '—',
      pricingType: 'llm',
      pricingLines: [
        { cells: { label: '标准版', input: `${s.currencySymbol}0.50/1M`, output: `${s.currencySymbol}3.00/1M` } },
        { cells: { label: '长文本', input: `${s.currencySymbol}1.00/1M`, output: `${s.currencySymbol}4.00/1M` } },
      ],
      builtInTools: [],
      rateLimits: 'RPM   15K',
      metadata: baseMetadata(),
    };
    const out = frame(<ModelInfoInk vm={vm} />);
    expect(out).toContain('标准版');
    expect(out).toContain('长文本');
    expect(out).toContain('Input');
    expect(out).toContain('Output');
  });
});
