import type { WorkspaceLimitResult } from '../../types/workspace.js';

export interface WorkspaceLimitViewModel {
  current: number;
  max: number;
  remaining: number;
  utilizationPct: number;
}

export function buildWorkspaceLimitViewModel(
  result: WorkspaceLimitResult,
): WorkspaceLimitViewModel {
  const max = Math.max(0, result.max);
  const current = Math.max(0, result.current);
  const remaining = Math.max(0, max - current);
  const utilizationPct = max === 0 ? 0 : Math.round((current / max) * 100);
  return { current, max, remaining, utilizationPct };
}
