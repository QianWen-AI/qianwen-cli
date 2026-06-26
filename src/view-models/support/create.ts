import type { CategoryNode, CategorySuggestion } from '../../types/support.js';

/**
 * View-models for the interactive `support create` flow. Builders are pure
 * shape transformers — the wizard's I/O lives in the command layer (Task #9).
 */

export interface CategoryNodeViewModel {
  id: string;
  name: string;
  children: CategoryNodeViewModel[];
  hasChildren: boolean;
  depth: number;
}

export interface CategoryTreeViewModel {
  roots: CategoryNodeViewModel[];
  flat: CategoryNodeViewModel[];
}

export function buildCategoryTreeViewModel(nodes: CategoryNode[]): CategoryTreeViewModel {
  const flat: CategoryNodeViewModel[] = [];
  const roots = nodes.map((n) => mapNode(n, 0, flat));
  return { roots, flat };
}

function mapNode(
  node: CategoryNode,
  depth: number,
  flat: CategoryNodeViewModel[],
): CategoryNodeViewModel {
  const children: CategoryNodeViewModel[] = [];
  const vm: CategoryNodeViewModel = {
    id: node.id,
    name: node.name || '\u2014',
    children,
    hasChildren: false,
    depth,
  };
  flat.push(vm);
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      children.push(mapNode(child, depth + 1, flat));
    }
    vm.hasChildren = true;
  }
  return vm;
}

export interface CategorySuggestionViewModel {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  score: number | null;
}

export interface CategorySuggestionsViewModel {
  items: CategorySuggestionViewModel[];
  isEmpty: boolean;
}

export function buildCategorySuggestionsViewModel(
  suggestions: CategorySuggestion[],
): CategorySuggestionsViewModel {
  const items = suggestions.map((s) => ({
    categoryId: s.categoryId,
    categoryName: s.categoryName || '\u2014',
    categoryPath: s.categoryPath || s.categoryName || '\u2014',
    score: typeof s.score === 'number' ? s.score : null,
  }));
  return { items, isEmpty: items.length === 0 };
}

export interface CreateTicketResultViewModel {
  ticketId: string;
  available: boolean;
  errorMessage: string | null;
}

export function buildCreateTicketResultViewModel(
  ticketId: string | null,
  errorMessage: string | null,
): CreateTicketResultViewModel {
  if (!ticketId) {
    return {
      ticketId: '',
      available: false,
      errorMessage: errorMessage ?? 'Ticket creation failed',
    };
  }
  return { ticketId, available: true, errorMessage: null };
}
