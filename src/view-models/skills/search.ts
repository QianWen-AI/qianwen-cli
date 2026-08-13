/**
 * Skills search view-model — pure mapping from the normalized service result
 * to render-friendly rows. No side effects (Clean Architecture layer 2).
 */

import type { SkillsSearchResult } from '../../types/skills.js';

const EM_DASH = '\u2014';

export interface SkillsSearchRowViewModel {
  index: number; // 1-based rank after exact-slug hoisting
  slug: string;
  name: string;
  description: string;
  publisher: string;
  /** Display value; falls back to an em dash when the API omits the version. */
  currentVersion: string;
  verified: boolean;
}

export interface SkillsSearchViewModel {
  query: string;
  totalCount: number;
  rows: SkillsSearchRowViewModel[];
  isEmpty: boolean;
}

export function buildSkillsSearchViewModel(data: SkillsSearchResult): SkillsSearchViewModel {
  const rows = data.results.map((item, i) => ({
    index: i + 1,
    slug: item.slug || EM_DASH,
    name: item.name || EM_DASH,
    description: item.description,
    publisher: item.publisher || EM_DASH,
    currentVersion: item.currentVersion ?? EM_DASH,
    verified: item.verified,
  }));

  return {
    query: data.query,
    totalCount: data.totalCount,
    rows,
    isEmpty: rows.length === 0,
  };
}
