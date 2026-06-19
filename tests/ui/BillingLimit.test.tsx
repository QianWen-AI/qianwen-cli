import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { BillingLimitInk } from '../../src/ui/BillingLimit.js';
import type { BillingLimitViewModel } from '../../src/view-models/billing/index.js';

const makeVm = (overrides: Partial<BillingLimitViewModel> = {}): BillingLimitViewModel => ({
  fields: [
    { label: 'Status', value: 'Active' },
    { label: 'Limit', value: '¥1000' },
    { label: 'Alert threshold', value: '80%' },
  ],
  currency: 'CNY',
  statusRaw: 'active',
  ...overrides,
});

const frame = (vm: BillingLimitViewModel) =>
  stripAnsi(render(<BillingLimitInk vm={vm} />).lastFrame() ?? '');

describe('BillingLimitInk', () => {
  it('renders title and subtitle (status · currency)', () => {
    const out = frame(makeVm());
    expect(out).toContain('Usage Limit');
    expect(out).toContain('Active');
    expect(out).toContain('CNY');
  });

  it('renders all fields with their values', () => {
    const out = frame(makeVm());
    expect(out).toContain('Status');
    expect(out).toContain('Limit');
    expect(out).toContain('¥1000');
    expect(out).toContain('Alert threshold');
    expect(out).toContain('80%');
  });

  it('renders em-dash for missing optional fields', () => {
    const out = frame(
      makeVm({
        fields: [
          { label: 'Status', value: 'Active' },
          { label: 'Limit', value: '—' },
          { label: 'Alert threshold', value: '—' },
        ],
      }),
    );
    expect(out).toContain('Alert threshold');
    expect(out).toContain('—');
  });

  it('renders Exceeded status when statusRaw is exceeded', () => {
    const out = frame(
      makeVm({
        statusRaw: 'exceeded',
        fields: [
          { label: 'Status', value: 'Exceeded' },
          { label: 'Limit', value: '¥500' },
          { label: 'Alert threshold', value: '90%' },
        ],
      }),
    );
    expect(out).toContain('Exceeded');
  });

  it('falls back to empty status string in subtitle when no Status field is present', () => {
    const out = frame(
      makeVm({
        fields: [
          { label: 'Limit', value: '¥1000' },
          { label: 'Alert threshold', value: '—' },
        ],
      }),
    );
    // Just check the section title still renders
    expect(out).toContain('Usage Limit');
    expect(out).toContain('CNY');
  });
});
