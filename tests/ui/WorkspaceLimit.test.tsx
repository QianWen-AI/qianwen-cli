import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { WorkspaceLimitInk } from '../../src/ui/WorkspaceLimit.js';
import type { WorkspaceLimitViewModel } from '../../src/view-models/workspace/index.js';

const makeVm = (overrides: Partial<WorkspaceLimitViewModel> = {}): WorkspaceLimitViewModel => ({
  current: 3,
  max: 10,
  remaining: 7,
  utilizationPct: 30,
  ...overrides,
});

const frame = (vm: WorkspaceLimitViewModel) =>
  stripAnsi(render(<WorkspaceLimitInk vm={vm} />).lastFrame() ?? '');

describe('WorkspaceLimitInk', () => {
  it('renders title with Current and Maximum rows', () => {
    const out = frame(makeVm());
    expect(out).toContain('Workspace Limit');
    expect(out).toContain('Current 3');
    expect(out).toContain('Maximum 10');
  });

  it('renders zero values when max is zero', () => {
    const out = frame(makeVm({ current: 0, max: 0, remaining: 0, utilizationPct: 0 }));
    expect(out).toContain('Current 0');
    expect(out).toContain('Maximum 0');
  });

  it('renders fully utilized values', () => {
    const out = frame(makeVm({ current: 5, max: 5, remaining: 0, utilizationPct: 100 }));
    expect(out).toContain('Current 5');
    expect(out).toContain('Maximum 5');
  });
});
