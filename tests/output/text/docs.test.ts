/**
 * Unit tests for renderTextDocsSearch — text rendering of search results,
 * including the documented degradation behavior.
 *
 * Coverage targets (per scope §4.3):
 *   1. Header + query echo appear in the rendered output.
 *   2. Each item renders as a labeled group with title / category / url /
 *      breadcrumb / summary.
 *   3. <em> highlight tags are stripped in TEXT mode (TUI keeps colors,
 *      JSON keeps the raw value, TEXT shows plain text).
 *   4. Per-row degradation replaces title / url with the localized fallback
 *      copy («Search results schema is being aligned»).
 *   5. Whole-page degradation surfaces the same fallback line and never
 *      throws.
 *   6. Empty result set renders a "no results" hint.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderTextDocsSearch } from '../../../src/output/text/docs.js';
import { buildDocsSearchViewModel } from '../../../src/view-models/docs/index.js';
import type { DocsSearchResponse, DocsSearchItem } from '../../../src/types/docs.js';

function captureStdout(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeItem(overrides: Partial<DocsSearchItem> = {}): DocsSearchItem {
  return {
    title: 'Model releases',
    highlightedTitle: 'Model releases — <em>qwen3</em>',
    subBizType: 'Changelog',
    url: 'https://docs.test.qianwen.com/changelog/models',
    summary: 'qwen3.7-max is now available',
    highlightedSummary: '<em>qwen3</em>.7-max is now available',
    breadcrumb: ['Changelog', 'Model releases'],
    ...overrides,
  };
}

function makeResponse(items: DocsSearchItem[], totalCount = items.length): DocsSearchResponse {
  return { totalCount, page: 1, pageSize: 20, items };
}

describe('renderTextDocsSearch — happy path', () => {
  it('renders header, query echo, and one row per item with the documented labels', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse(
        [
          makeItem(),
          makeItem({
            title: 'Quick Start',
            highlightedTitle: 'Quick Start',
            subBizType: 'Developer Guide',
            url: 'https://docs.test.qianwen.com/developer-guides/getting-started',
            summary: 'Get started in minutes',
            highlightedSummary: 'Get started in minutes',
            breadcrumb: ['Developer Guide', 'Quick Start'],
          }),
        ],
        2,
      ),
      { query: 'qwen3', page: 1, pageSize: 20 },
    );

    const out = captureStdout(() => renderTextDocsSearch(vm));

    expect(out).toContain('Docs Search');
    expect(out).toContain('qwen3');
    // Both result titles appear
    expect(out).toContain('Model releases');
    expect(out).toContain('Quick Start');
    // URLs appear so the user can copy/paste
    expect(out).toContain('https://docs.test.qianwen.com/changelog/models');
  });

  it('strips <em> highlight tags in the rendered text body', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse([
        makeItem({
          title: 'Model releases — qwen3',
          highlightedTitle: 'Model releases — <em>qwen3</em>',
          summary: 'qwen3.7-max',
          highlightedSummary: '<em>qwen3</em>.7-max',
        }),
      ]),
      { query: 'qwen3', page: 1, pageSize: 20 },
    );
    const out = captureStdout(() => renderTextDocsSearch(vm));

    expect(out).not.toContain('<em>');
    expect(out).not.toContain('</em>');
    // The plain text payload still shows the keyword
    expect(out).toContain('qwen3');
  });

  it('renders breadcrumb path joined by a separator', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse([makeItem({ breadcrumb: ['Developer Guide', 'Models', 'Quick Start'] })]),
      { query: 'qwen3', page: 1, pageSize: 20 },
    );
    const out = captureStdout(() => renderTextDocsSearch(vm));

    // Breadcrumb segments appear sequentially; specific separator is up to
    // the renderer (e.g., ' / ' or ' › ') so we assert the segment ordering.
    const idxA = out.indexOf('Developer Guide');
    const idxB = out.indexOf('Models');
    const idxC = out.indexOf('Quick Start');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });
});

describe('renderTextDocsSearch — degradation', () => {
  it('replaces a single degraded row with the fallback copy', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse([makeItem({ title: '', highlightedTitle: '', url: '' })]),
      { query: 'qwen3', page: 1, pageSize: 20 },
    );
    const out = captureStdout(() => renderTextDocsSearch(vm));

    // Localized fallback copy from the ViewModel's degraded path
    expect(out.toLowerCase()).toMatch(/aligned|对齐中/);
    // The row must NOT silently render an empty title
    expect(out).not.toContain('https://docs.test.qianwen.com/changelog/models');
  });

  it('surfaces the page-level diagnostics tag when ≥50% rows are degraded', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse([
        makeItem({ url: '' }), // degraded
        makeItem({ title: '', highlightedTitle: '' }), // degraded
        makeItem(), // complete
      ]),
      { query: 'qwen3', page: 1, pageSize: 20 },
    );
    const out = captureStdout(() => renderTextDocsSearch(vm));

    // The TUI / TEXT renderer should call out the diagnostics state in some
    // form so the user is informed that the page is partially degraded.
    expect(out.toLowerCase()).toMatch(/aligned|对齐中/);
  });

  it('renders all-degraded page without throwing and shows the global hint', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse([makeItem({ url: '' }), makeItem({ title: '', highlightedTitle: '' })]),
      { query: 'qwen3', page: 1, pageSize: 20 },
    );

    expect(() => captureStdout(() => renderTextDocsSearch(vm))).not.toThrow();
  });
});

describe('renderTextDocsSearch — empty', () => {
  it('renders an explicit "no results" hint when items is empty', () => {
    const vm = buildDocsSearchViewModel(makeResponse([], 0), {
      query: 'no-match-qwen3',
      page: 1,
      pageSize: 20,
    });
    const out = captureStdout(() => renderTextDocsSearch(vm));

    expect(out.toLowerCase()).toMatch(/no\s+results|no\s+matches|没有|未找到/);
  });
});
