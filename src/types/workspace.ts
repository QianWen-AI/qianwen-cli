export interface Workspace {
  id: string;
  name: string;
  region: string;
  createdAt: string;
  isDefault: boolean;
  tenantId: number;
}

export interface WorkspaceListResult {
  items: Workspace[];
  total: number;
  limit: number;
}

export interface WorkspaceLimitResult {
  current: number;
  max: number;
}
