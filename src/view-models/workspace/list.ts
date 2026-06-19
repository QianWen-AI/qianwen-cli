import type { Workspace, WorkspaceListResult } from '../../types/workspace.js';

export interface WorkspaceRowViewModel {
  id: string;
  name: string;
  region: string;
  createdAt: string;
  isDefault: boolean;
}

export interface WorkspaceListViewModel {
  rows: WorkspaceRowViewModel[];
  total: number;
  limit: number;
}

export function buildWorkspaceListViewModel(result: WorkspaceListResult): WorkspaceListViewModel {
  return {
    rows: result.items.map(toRow),
    total: result.total,
    limit: result.limit,
  };
}

function toRow(item: Workspace): WorkspaceRowViewModel {
  return {
    id: item.id,
    name: item.name || '—',
    region: item.region || '—',
    createdAt: item.createdAt || '—',
    isDefault: item.isDefault,
  };
}
