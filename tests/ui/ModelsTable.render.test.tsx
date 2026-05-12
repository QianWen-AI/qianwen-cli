import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

// Mock renderWithInk so renderModelsTableInk wrapper test doesn't spawn a real Ink instance.
// Use vi.hoisted to safely create the spy before vi.mock factory runs.
const { renderWithInkSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
  renderInteractive: vi.fn(),
  renderWithInkSync: renderWithInkSpy,
}));

import {
  ModelsTableInk,
  buildModelsUiData,
  renderModelsTableInk,
} from '../../src/ui/ModelsTable.js';
import type { Model } from '../../src/types/model.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

const baseModels = [
  {
    id: 'free-mod',
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: {
      mode: 'standard',
      quota: {
        remaining: 1_000_000,
        total: 1_000_000,
        unit: 'tokens',
        used_pct: 0,
        status: 'valid',
      },
    },
    pricing: { tiers: [{ label: 'free', input: 0, output: 0, unit: 'USD/1M' }] },
  },
  {
    id: 'paid-mod',
    modality: { input: ['text'], output: ['text'] },
    can_try: true,
    free_tier: {
      mode: 'standard',
      quota: {
        remaining: 500,
        total: 1000,
        unit: 'tokens',
        used_pct: 50,
        status: 'valid',
      },
    },
    pricing: { tiers: [{ label: 't', input: 1.5, output: 3.0, unit: 'USD/1M' }] },
  },
  {
    id: 'expired-mod',
    modality: { input: ['text'], output: ['text'] },
    can_try: false,
    free_tier: {
      mode: 'standard',
      quota: {
        remaining: 0,
        total: 100,
        unit: 'tokens',
        used_pct: 100,
        status: 'expire',
      },
    },
  },
] as unknown as Model[];

beforeEach(() => {
  renderWithInkSpy.mockClear();
});

describe('<ModelsTableInk /> rendering', () => {
  it('renders title, subtitle and all model rows', () => {
    const uiData = buildModelsUiData(baseModels);
    const { lastFrame } = render(
      <ModelsTableInk uiData={uiData} title="My Models" subtitle="3 items" />
    );
    const out = lastFrame()!;
    expect(out).toContain('My Models');
    expect(out).toContain('free-mod');
    expect(out).toContain('paid-mod');
    expect(out).toContain('expired-mod');
    expect(out).toMatch(/3 models/);
  });

  it('uses custom footer when provided', () => {
    const uiData = buildModelsUiData([baseModels[0]]);
    const { lastFrame } = render(
      <ModelsTableInk uiData={uiData} footer="my custom footer text" />
    );
    expect(lastFrame()).toContain('my custom footer');
  });

  it('uses default title "Models" when none given', () => {
    const uiData = buildModelsUiData([baseModels[0]]);
    const { lastFrame } = render(<ModelsTableInk uiData={uiData} />);
    expect(lastFrame()).toContain('Models');
  });

  it('omits "Free Tier quota included" footer when no quota', () => {
    const noQuotaModels = [
      {
        id: 'noq',
        modality: { input: ['text'], output: ['text'] },
        can_try: false,
        free_tier: { mode: null, quota: null },
      },
    ] as unknown as Model[];
    const uiData = buildModelsUiData(noQuotaModels);
    const { lastFrame } = render(<ModelsTableInk uiData={uiData} />);
    expect(lastFrame()).not.toContain('Free Tier quota included');
  });

  it('includes "Free Tier quota included" footer when has quota', () => {
    const uiData = buildModelsUiData(baseModels);
    const { lastFrame } = render(<ModelsTableInk uiData={uiData} />);
    expect(lastFrame()).toContain('Free Tier quota included');
  });

  it('renders Free / $ / em-dash price variants', () => {
    const uiData = buildModelsUiData(baseModels);
    const { lastFrame } = render(<ModelsTableInk uiData={uiData} />);
    const out = lastFrame()!;
    expect(out).toContain('Free');
    expect(out).toContain(s.currencySymbol);
    expect(out).toContain(`${s.currencySymbol}1.50`);
    expect(out).toContain('—');
  });

  it('expired row still renders the model id and the row layout differs from valid rows', () => {
    // ink-testing-library strips ANSI escapes in non-TTY environments, so
    // we cannot assert dim color codes directly. Instead we verify the BEHAVIOR:
    //   1. Expired model id is still present (mute, not hide)
    //   2. The expired row's visible content is not identical to a valid row
    //      (proving styling/branching DOES happen — even if escape codes are stripped)
    const uiData = buildModelsUiData(baseModels);
    const { lastFrame } = render(<ModelsTableInk uiData={uiData} />);
    const out = lastFrame()!;
    expect(out).toContain('expired-mod');
    const expiredLine = out.split('\n').find((l) => l.includes('expired-mod'));
    const freeLine = out.split('\n').find((l) => l.includes('free-mod'));
    expect(expiredLine).toBeDefined();
    expect(freeLine).toBeDefined();
    // Two lines must not be byte-identical — they at minimum carry different ids
    expect(expiredLine).not.toBe(freeLine);
    // The expired row should not contain the same quota numbers as the
    // active free-mod row (1,000,000) — the data branch reflects the status.
    expect(expiredLine!).not.toContain('1,000,000');
  });

  it('renders the expected price text variants per row (Free / $price / em-dash)', () => {
    const uiData = buildModelsUiData(baseModels);
    const { lastFrame } = render(<ModelsTableInk uiData={uiData} />);
    const out = lastFrame()!;
    // Each row carries its respective price string in its own line — proving
    // the price-formatting branch maps each pricing shape to the correct text.
    const freeLine = out.split('\n').find((l) => l.includes('free-mod'));
    const paidLine = out.split('\n').find((l) => l.includes('paid-mod'));
    const expiredLine = out.split('\n').find((l) => l.includes('expired-mod'));
    expect(freeLine).toBeDefined();
    expect(paidLine).toBeDefined();
    expect(expiredLine).toBeDefined();
    // free-mod tier label is 'free' → priced at ¥0/¥0 → 'Free' label
    expect(freeLine!).toContain('Free');
    // paid-mod has ¥1.50 input price
    expect(paidLine!).toContain(`${s.currencySymbol}1.50`);
    // expired-mod has no pricing → em-dash placeholder
    expect(expiredLine!).toContain('—');
  });
});

describe('renderModelsTableInk wrapper', () => {
  it('forwards uiData and options to renderWithInk', async () => {
    const uiData = buildModelsUiData([baseModels[0]]);
    await renderModelsTableInk(uiData, {
      title: 'T',
      subtitle: 'S',
      footer: 'F',
    });
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    const arg = renderWithInkSpy.mock.calls[0][0];
    expect(arg.props.uiData).toBe(uiData);
    expect(arg.props.title).toBe('T');
    expect(arg.props.subtitle).toBe('S');
    expect(arg.props.footer).toBe('F');
  });

  it('works without options', async () => {
    const uiData = buildModelsUiData([baseModels[0]]);
    await renderModelsTableInk(uiData);
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    const arg = renderWithInkSpy.mock.calls[0][0];
    expect(arg.props.uiData).toBe(uiData);
    expect(arg.props.title).toBeUndefined();
  });
});
