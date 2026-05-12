import React from 'react';
import { Table } from './Table.js';
import { Section } from './Section.js';
import { theme, buildProgressBar } from './theme.js';
import { MODEL_LIST_COLUMNS } from '../commands/models/shared.js';
import { renderWithInk } from './render.js';
import {
  buildModelListViewModelFromModels,
  type ModelsListViewModel,
  type ModelRowViewModel,
} from '../view-models/models.js';

// ── UI-specific ViewModel extension (adds color metadata) ────────────

export interface ModelRowUiData extends ModelRowViewModel {
  freeTierBar: string; // pre-built progress bar string (empty if no quota)
}

export interface ModelsListUiData {
  rows: ModelRowUiData[];
  total: number;
  hasQuota: boolean;
}

/**
 * Build UI data from raw model data, including color metadata for row styling.
 * Wraps the pure ViewModel builder and adds presentation concerns.
 */
export function buildModelsUiData(
  models: Parameters<typeof buildModelListViewModelFromModels>[0],
  details?: Parameters<typeof buildModelListViewModelFromModels>[1],
): ModelsListUiData {
  const vm = buildModelListViewModelFromModels(models, details);

  const rows: ModelRowUiData[] = models.map((model, i) => {
    const vmRow = vm.rows[i];
    let freeTierBar: string;
    if (vmRow.freeTierExpired) {
      // Expired: show empty muted bar with "expired" label
      const emptyBar = theme.muted(theme.bar.empty.repeat(10));
      freeTierBar = `${emptyBar} ${theme.muted('expired')}`;
    } else if (vmRow.freeTierRemainingPct != null) {
      freeTierBar = buildProgressBar(vmRow.freeTierRemainingPct, 10, theme.data, true);
    } else {
      freeTierBar = '';
    }
    return { ...vmRow, freeTierBar };
  });

  return {
    rows,
    total: vm.total,
    hasQuota: models.some((m) => m.free_tier.quota != null),
  };
}

// ── Ink React Component ─────────────────────────────────────────────

export interface ModelsTableInkProps {
  uiData: ModelsListUiData;
  title?: string;
  subtitle?: string;
  footer?: string;
}

/**
 * Ink React component for models list/search display.
 * Wraps the Table in a Section with proper styling and quota status coloring.
 */
export function ModelsTableInk({ uiData, title, subtitle, footer }: ModelsTableInkProps) {
  const sectionTitle = title ?? 'Models';
  const sectionFooter =
    footer ??
    `${uiData.total} models${uiData.hasQuota ? '  \u00b7  Free Tier quota included' : ''}`;

  const tableData = uiData.rows.map((row) => {
    // Colorize price amount
    let priceDisplay = row.price;
    if (row.price.toLowerCase().includes('free')) {
      priceDisplay = theme.success(row.price);
    } else if (row.price.includes('$') || row.price.includes('¥')) {
      priceDisplay = theme.accent(row.price);
    }

    // Mute free tier columns when expired
    const freeTierAmt = row.freeTierExpired ? theme.muted(row.freeTierAmt) : row.freeTierAmt;
    const freeTierUnit = row.freeTierExpired ? theme.muted(row.freeTierUnit) : row.freeTierUnit;

    return {
      id: row.id,
      modalityInput: row.modalityInput,
      modalityOutput: row.modalityOutput,
      freeTierAmt,
      freeTierUnit,
      freeTierBar: row.freeTierBar,
      price: priceDisplay,
      priceUnit: row.priceUnit,
    };
  });

  return (
    <Section title={sectionTitle} subtitle={subtitle} footer={sectionFooter}>
      <Table columns={MODEL_LIST_COLUMNS} data={tableData} paddingLeft={0} />
    </Section>
  );
}

/**
 * Render models table via Ink.
 * Used by non-interactive mode as a drop-in replacement for the old render+unmount pattern.
 */
export async function renderModelsTableInk(
  uiData: ModelsListUiData,
  options?: {
    title?: string;
    subtitle?: string;
    footer?: string;
  },
): Promise<void> {
  await renderWithInk(<ModelsTableInk uiData={uiData} {...options} />);
}

// Re-export shared constants for backward compatibility
export { MODEL_LIST_COLUMNS, buildModelListViewModelFromModels as buildModelsViewModel };
export type { ModelsListViewModel, ModelRowViewModel };
