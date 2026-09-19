/**
 * Tests for the skills search view-model — pure mapping, display fallbacks
 * and the isEmpty flag.
 */
import { describe, it, expect } from 'vitest';
import { buildSkillsSearchViewModel } from '../../../src/view-models/skills/index.js';
import type { SkillsSearchResult } from '../../../src/types/skills.js';

const EM_DASH = '\u2014';

describe('buildSkillsSearchViewModel', () => {
  it('maps results to 1-based indexed rows', () => {
    const data: SkillsSearchResult = {
      query: 'pdf',
      totalCount: 2,
      results: [
        {
          slug: '@qianwen-ai/pdf-a',
          name: 'PDF A',
          description: 'first',
          publisher: 'acme',
          currentVersion: '1.0.0',
          verified: true,
        },
        {
          slug: '@qianwen-ai/pdf-b',
          name: 'PDF B',
          description: 'second',
          publisher: 'beta',
          verified: false,
        },
      ],
    };

    const vm = buildSkillsSearchViewModel(data);

    expect(vm.query).toBe('pdf');
    expect(vm.totalCount).toBe(2);
    expect(vm.isEmpty).toBe(false);
    expect(vm.rows[0]).toEqual({
      index: 1,
      slug: '@qianwen-ai/pdf-a',
      name: 'PDF A',
      description: 'first',
      publisher: 'acme',
      currentVersion: '1.0.0',
      verified: true,
    });
    expect(vm.rows[1].index).toBe(2);
  });

  it('renders an em dash for a missing currentVersion and blank fields', () => {
    const vm = buildSkillsSearchViewModel({
      query: 'x',
      totalCount: 1,
      results: [{ slug: '', name: '', description: '', publisher: '', verified: false }],
    });

    expect(vm.rows[0].slug).toBe(EM_DASH);
    expect(vm.rows[0].name).toBe(EM_DASH);
    expect(vm.rows[0].publisher).toBe(EM_DASH);
    expect(vm.rows[0].currentVersion).toBe(EM_DASH);
  });

  it('flags empty result sets', () => {
    const vm = buildSkillsSearchViewModel({ query: 'none', totalCount: 0, results: [] });

    expect(vm.isEmpty).toBe(true);
    expect(vm.rows).toEqual([]);
  });
});
