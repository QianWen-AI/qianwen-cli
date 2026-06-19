import { describe, it, expect } from 'vitest';
import { buildWorkspaceListViewModel } from '../../../src/view-models/workspace/list.js';
import type { WorkspaceListResult } from '../../../src/types/workspace.js';

const make = (overrides: Partial<WorkspaceListResult> = {}): WorkspaceListResult => ({
  items: [],
  total: 0,
  limit: 10,
  ...overrides,
});

describe('buildWorkspaceListViewModel', () => {
  it('maps each workspace into a row preserving id and isDefault', () => {
    const vm = buildWorkspaceListViewModel(
      make({
        items: [
          {
            id: 'ws-1',
            name: 'prod',
            region: 'cn-hangzhou',
            createdAt: '2026-01-01T00:00:00Z',
            isDefault: true,
            tenantId: 285611,
          },
          {
            id: 'ws-2',
            name: 'dev',
            region: 'cn-shanghai',
            createdAt: '2026-01-15T00:00:00Z',
            isDefault: false,
            tenantId: 285612,
          },
        ],
        total: 2,
        limit: 25,
      }),
    );
    expect(vm.rows).toHaveLength(2);
    expect(vm.rows[0]).toEqual({
      id: 'ws-1',
      name: 'prod',
      region: 'cn-hangzhou',
      createdAt: '2026-01-01T00:00:00Z',
      isDefault: true,
    });
    expect(vm.rows[1].isDefault).toBe(false);
    expect(vm.total).toBe(2);
    expect(vm.limit).toBe(25);
  });

  it('substitutes em-dash for empty string fields except id', () => {
    const vm = buildWorkspaceListViewModel(
      make({
        items: [
          {
            id: 'ws-empty',
            name: '',
            region: '',
            createdAt: '',
            isDefault: false,
            tenantId: 0,
          },
        ],
        total: 1,
      }),
    );
    const row = vm.rows[0];
    expect(row.id).toBe('ws-empty');
    expect(row.name).toBe('—');
    expect(row.region).toBe('—');
    expect(row.createdAt).toBe('—');
    expect(row.isDefault).toBe(false);
  });

  it('returns empty rows when items is empty', () => {
    const vm = buildWorkspaceListViewModel(make({ items: [], total: 0, limit: 50 }));
    expect(vm.rows).toEqual([]);
    expect(vm.total).toBe(0);
    expect(vm.limit).toBe(50);
  });

  it('passes through total and limit unchanged', () => {
    const vm = buildWorkspaceListViewModel(
      make({
        items: [
          {
            id: 'a',
            name: 'a',
            region: 'r',
            createdAt: 't',
            isDefault: false,
            tenantId: 0,
          },
        ],
        total: 99,
        limit: 5,
      }),
    );
    expect(vm.total).toBe(99);
    expect(vm.limit).toBe(5);
  });
});
