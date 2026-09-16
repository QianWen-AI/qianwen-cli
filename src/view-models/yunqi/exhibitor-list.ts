import type { Exhibit, ExhibitorListResult, ExhibitLocation } from '../../types/yunqi.js';
import { truncateCell } from './shared.js';

export interface ExhibitorRowViewModel {
  id: string;
  code: string;
  name: string;
  hall: string;
  zone: string;
  booth: string;
  description: string;
}

export interface ExhibitorListViewModel {
  rows: ExhibitorRowViewModel[];
  page: number;
  pageSize: number;
  total: number;
}

const WIDTHS = {
  id: 16,
  code: 16,
  name: 36,
  hall: 24,
  zone: 24,
  booth: 24,
  description: 32,
} as const;

/**
 * One row per booth: the exhibitor record itself carries no identity, so an
 * item with several exhibits contributes several rows and an item with none
 * contributes none. `total` still counts exhibitors, not rows.
 */
export function buildExhibitorListViewModel(result: ExhibitorListResult): ExhibitorListViewModel {
  return {
    rows: result.exhibitors.flatMap((item) => (item.exhibits ?? []).map(toRow)),
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  };
}

function locationLabel(loc: ExhibitLocation | undefined): string | undefined {
  return loc?.name ?? loc?.code;
}

function toRow(item: Exhibit): ExhibitorRowViewModel {
  return {
    id: truncateCell(item.exhibitId, WIDTHS.id),
    code: truncateCell(item.exhibitCode, WIDTHS.code),
    name: truncateCell(item.name, WIDTHS.name),
    hall: truncateCell(locationLabel(item.hall), WIDTHS.hall),
    zone: truncateCell(locationLabel(item.zone), WIDTHS.zone),
    booth: truncateCell(locationLabel(item.booth), WIDTHS.booth),
    description: truncateCell(item.description, WIDTHS.description),
  };
}
