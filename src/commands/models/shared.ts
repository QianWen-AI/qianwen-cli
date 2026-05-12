import type { Column } from '../../ui/Table.js';
import { theme, buildProgressBar } from '../../ui/theme.js';
import { abbreviateModality } from '../../utils/modality.js';
import type { Model, ModelDetail } from '../../types/model.js';
import { splitPrice } from '../../utils/formatting.js';
import { formatFreeTierSplit, formatPriceFromPricing } from '../../view-models/models.js';

// Re-export formatting utilities for backward compatibility
export { formatFreeTier, formatPriceFromPricing } from '../../view-models/models.js';

/**
 * Column definitions for model list/search tables.
 */
export const MODEL_LIST_COLUMNS: Column[] = [
  { key: 'id', header: 'Model ID', color: (v: string) => theme.data(v) },
  { key: 'modalityInput', header: 'Input' },
  { key: 'modalityOutput', header: 'Output' },
  { key: 'freeTierAmt', header: 'Free Quota', align: 'right' },
  { key: 'freeTierUnit', header: 'Unit' },
  { key: 'freeTierBar', header: 'Left%', minWidth: 10 },
  { key: 'price', header: 'Price', align: 'right' },
  { key: 'priceUnit', header: 'Unit' },
];

/** Apply price color: green for free, amber for paid. */
function colorizePrice(price: string): string {
  if (price.toLowerCase().includes('free')) return theme.success(price);
  if (price.includes('$') || price.includes('¥')) return theme.accent(price);
  return price;
}

/**
 * Parse pagination options from string parameters.
 */
export function parsePaginationOptions(
  pageStr?: string,
  perPageStr?: string,
): { page: number; perPage: number } {
  const rawPage = pageStr != null ? parseInt(pageStr, 10) || 1 : 1;
  const rawPerPage = perPageStr != null ? parseInt(perPageStr, 10) || 20 : 20;

  const page = Math.max(1, rawPage);
  const perPage = Math.max(1, rawPerPage);

  if (pageStr != null && rawPage < 1) {
    process.stderr.write(`Warning: --page must be ≥ 1, using ${page}\n`);
  }
  if (perPageStr != null && rawPerPage < 1) {
    process.stderr.write(`Warning: --per-page must be ≥ 1, using ${perPage}\n`);
  }

  return { page, perPage };
}

/**
 * Print pagination footer for non-JSON modes.
 */
export function printPaginationFooter(page: number, totalPages: number, totalItems: number): void {
  if (totalPages > 1) {
    console.log(`\nPage ${page} of ${totalPages} (${totalItems} models total)`);
    if (page < totalPages) {
      console.log(`Use --page ${page + 1} to see next page`);
    }
  }
}

/**
 * Build table rows from models and their detail info.
 * Used by InteractiveTable's loadPage function.
 */
export function buildModelRows(
  modelsWithQuota: Model[],
  details: (ModelDetail | null)[],
): Record<string, string>[] {
  return modelsWithQuota.map((model, i) => {
    const detail = details[i];
    const pricing = detail?.pricing ?? model.pricing;
    const priceStr = pricing
      ? formatPriceFromPricing(pricing, model.free_tier.mode === 'only')
      : '\u2014';

    const { amount: priceAmt, unit: priceUnit } = splitPrice(priceStr);
    const { amount: ftAmt, unit: ftUnit, expired: ftExpired } = formatFreeTierSplit(model);
    const remainingPct = model.free_tier.quota
      ? model.free_tier.quota.status === 'expire'
        ? 0
        : Math.round((100 - model.free_tier.quota.used_pct) * 10) / 10
      : undefined;

    // Build free tier bar: expired shows empty muted bar with "expired" label
    let freeTierBar = '';
    if (ftExpired) {
      const emptyBar = theme.muted(theme.bar.empty.repeat(10));
      freeTierBar = `${emptyBar} ${theme.muted('expired')}`;
    } else if (remainingPct != null) {
      freeTierBar = buildProgressBar(remainingPct, 10, theme.data, true);
    }

    // Mute free tier columns when expired
    const freeTierAmt = ftExpired ? theme.muted(ftAmt) : ftAmt;
    const freeTierUnit = ftExpired ? theme.muted(ftUnit) : ftUnit;

    return {
      id: model.id,
      modalityInput: model.modality.input.map((t) => abbreviateModality(t as any)).join('+'),
      modalityOutput: model.modality.output.map((t) => abbreviateModality(t as any)).join('+'),
      canTry: model.can_try ? 'Yes' : 'No',
      freeTierAmt,
      freeTierUnit,
      freeTierBar,
      price: colorizePrice(priceAmt),
      priceUnit,
    };
  });
}
