import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { WorkspaceListInk } from '../../src/ui/WorkspaceList.js';
import type { WorkspaceListViewModel } from '../../src/view-models/workspace/index.js';

const makeRow = (overrides: Partial<WorkspaceListViewModel['rows'][number]> = {}) => ({
  id: 'ws-1',
  name: 'prod',
  region: 'cn-hangzhou',
  createdAt: '2026-01-01',
  isDefault: true,
  ...overrides,
});

const makeVm = (overrides: Partial<WorkspaceListViewModel> = {}): WorkspaceListViewModel => ({
  rows: [makeRow()],
  total: 1,
  limit: 25,
  ...overrides,
});

const frame = (vm: WorkspaceListViewModel) =>
  stripAnsi(render(<WorkspaceListInk vm={vm} />).lastFrame() ?? '');

describe('WorkspaceListInk', () => {
  it('renders title and footer "<total> workspaces · Limit <limit>" when limit > 0', () => {
    const out = frame(makeVm({ total: 5, limit: 25 }));
    expect(out).toContain('Workspaces');
    expect(out).toContain('5 workspaces');
    expect(out).toContain('Limit 25');
  });

  it('omits limit segment when limit is 0', () => {
    const out = frame(makeVm({ total: 3, limit: 0 }));
    expect(out).toContain('3 workspaces');
    expect(out).not.toContain('Limit');
  });

  it('renders row cells and isDefault as yes/no', () => {
    const out = frame(
      makeVm({
        rows: [
          makeRow({ id: 'ws-A', name: 'A', isDefault: true }),
          makeRow({ id: 'ws-B', name: 'B', isDefault: false }),
        ],
      }),
    );
    expect(out).toContain('ws-A');
    expect(out).toContain('ws-B');
    expect(out).toContain('yes');
    expect(out).toContain('no');
  });

  it('renders region for each workspace', () => {
    const out = frame(makeVm());
    expect(out).toContain('cn-hangzhou');
  });

  it('renders empty list with zero total', () => {
    const out = frame(makeVm({ rows: [], total: 0, limit: 0 }));
    expect(out).toContain('Workspaces');
    expect(out).toContain('0 workspaces');
  });

  it('renders em-dash placeholders without crashing', () => {
    const out = frame(
      makeVm({
        rows: [
          makeRow({
            name: '—',
            region: '—',
            createdAt: '—',
          }),
        ],
      }),
    );
    expect(out).toContain('—');
  });
});
