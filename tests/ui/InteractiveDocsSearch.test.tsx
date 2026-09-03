import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { InteractiveDocsSearch } from '../../src/ui/InteractiveDocsSearch.js';
import { visibleWidth } from '../../src/ui/textWrap.js';
import type {
  DocsSearchViewModel,
  DocsSearchItemViewModel,
  DocContentViewModel,
} from '../../src/view-models/docs/index.js';

function makeItem(overrides: Partial<DocsSearchItemViewModel> = {}): DocsSearchItemViewModel {
  return {
    index: 1,
    title: 'Getting Started',
    highlightedTitle: 'Getting <em>Started</em>',
    subBizType: 'Developer Guide',
    url: 'https://mock-docs.test.qianwenai.com/developer-guides/getting-started',
    summary: 'Learn how to get started with QianWen.',
    highlightedSummary: 'Learn how to get <em>started</em> with QianWen.',
    breadcrumb: ['Developer Guide', 'Getting Started'],
    isDegraded: false,
    ...overrides,
  };
}

function makeVm(overrides: Partial<DocsSearchViewModel> = {}): DocsSearchViewModel {
  return {
    query: 'getting started',
    totalCount: 2,
    page: 1,
    pageSize: 20,
    pageCount: 1,
    items: [
      makeItem(),
      makeItem({ index: 2, title: 'Quick Start', highlightedTitle: 'Quick Start' }),
    ],
    diagnostics: [],
    isEmpty: false,
    isAllDegraded: false,
    degradedPlaceholder: 'Search results schema is being aligned',
    ...overrides,
  };
}

const ORIGINAL_COLUMNS = process.stdout.columns;
const ORIGINAL_ROWS = process.stdout.rows;

function setTermSize(columns: number, rows: number): void {
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
}

beforeEach(() => {
  setTermSize(120, 40);
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: ORIGINAL_COLUMNS, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: ORIGINAL_ROWS, configurable: true });
});

function frame(el: React.ReactElement): string {
  const inst = render(el);
  const f = stripAnsi(inst.lastFrame() ?? '');
  inst.unmount();
  return f;
}

describe('InteractiveDocsSearch', () => {
  it('should render search results with selection indicator', () => {
    const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
    const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();

    const out = frame(
      <InteractiveDocsSearch
        initialVm={makeVm()}
        loadPage={loadPage}
        fetchContent={fetchContent}
      />,
    );

    expect(out).toContain('\u25B6');
    expect(out).toContain('Getting Started');
    expect(out).toContain('Quick Start');
  });

  it('should display page info in subtitle', () => {
    const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
    const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();

    const out = frame(
      <InteractiveDocsSearch
        initialVm={makeVm({ totalCount: 40, pageCount: 2 })}
        loadPage={loadPage}
        fetchContent={fetchContent}
      />,
    );

    expect(out).toContain('Page 1/2');
    expect(out).toContain('getting started');
  });

  it('should render empty state', () => {
    const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
    const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();

    const out = frame(
      <InteractiveDocsSearch
        initialVm={makeVm({ items: [], isEmpty: true, totalCount: 0 })}
        loadPage={loadPage}
        fetchContent={fetchContent}
      />,
    );

    expect(out.toLowerCase()).toMatch(/no\s+results/);
  });

  it('should show item URLs', () => {
    const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
    const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();

    const out = frame(
      <InteractiveDocsSearch
        initialVm={makeVm()}
        loadPage={loadPage}
        fetchContent={fetchContent}
      />,
    );

    expect(out).toContain('mock-docs.test.qianwenai.com');
  });

  it('should show keyboard shortcuts in footer', () => {
    const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
    const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();

    const out = frame(
      <InteractiveDocsSearch
        initialVm={makeVm()}
        loadPage={loadPage}
        fetchContent={fetchContent}
      />,
    );

    expect(out).toContain('q: quit');
  });
});

describe('InteractiveDocsSearch — TUI display specification', () => {
  function makeItems(count: number): DocsSearchItemViewModel[] {
    return Array.from({ length: count }, (_, i) =>
      makeItem({
        index: i + 1,
        title: `Doc Title ${i + 1}`,
        highlightedTitle: `Doc Title ${i + 1}`,
        summary: `Summary for document ${i + 1}`,
        highlightedSummary: `Summary for document ${i + 1}`,
        url: `https://mock-docs.test.qianwenai.com/doc-${i + 1}`,
      }),
    );
  }

  describe('F1: item count rendering', () => {
    it('renders all items when count equals page limit (5)', () => {
      const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
      const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
      const items = makeItems(5);

      const out = frame(
        <InteractiveDocsSearch
          initialVm={makeVm({ items, totalCount: 5 })}
          loadPage={loadPage}
          fetchContent={fetchContent}
        />,
      );

      for (const item of items) {
        expect(out).toContain(item.title);
      }
    });

    it('renders exact item count provided in vm.items', () => {
      const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
      const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
      const items = makeItems(3);

      const out = frame(
        <InteractiveDocsSearch
          initialVm={makeVm({ items, totalCount: 3 })}
          loadPage={loadPage}
          fetchContent={fetchContent}
        />,
      );

      for (const item of items) {
        expect(out).toContain(item.title);
      }
      expect(out).not.toContain('Doc Title 4');
    });
  });

  describe('F2: summary fold/unfold on selection', () => {
    it('shows summary for the initially selected (first) item', () => {
      const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
      const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
      const items = makeItems(3);

      const out = frame(
        <InteractiveDocsSearch
          initialVm={makeVm({ items, totalCount: 3 })}
          loadPage={loadPage}
          fetchContent={fetchContent}
        />,
      );

      expect(out).toContain('Summary for document 1');
    });

    it('does not display summary for non-selected items', () => {
      const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
      const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
      const items = makeItems(3);

      const out = frame(
        <InteractiveDocsSearch
          initialVm={makeVm({ items, totalCount: 3 })}
          loadPage={loadPage}
          fetchContent={fetchContent}
        />,
      );

      expect(out).not.toContain('Summary for document 2');
      expect(out).not.toContain('Summary for document 3');
    });
  });

  describe('F3: selected item visual indicator', () => {
    it('selected item renders with \u25B6 prefix', () => {
      const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
      const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
      const items = makeItems(2);

      const out = frame(
        <InteractiveDocsSearch
          initialVm={makeVm({ items, totalCount: 2 })}
          loadPage={loadPage}
          fetchContent={fetchContent}
        />,
      );

      // \u25B6 should appear (for the selected item)
      expect(out).toContain('\u25B6');
    });

    it('selected and non-selected items have distinct visual representation', () => {
      const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
      const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
      const items = makeItems(2);

      const inst = render(
        <InteractiveDocsSearch
          initialVm={makeVm({ items, totalCount: 2 })}
          loadPage={loadPage}
          fetchContent={fetchContent}
        />,
      );

      // Get the raw frame (with ANSI codes) to detect styling differences
      const rawFrame = inst.lastFrame() ?? '';
      const lines = rawFrame.split('\n');

      // Find lines containing each title
      const firstItemLine = lines.find((l) => l.includes('Doc Title 1'));
      const secondItemLine = lines.find((l) => l.includes('Doc Title 2'));

      // They should be visually different (different ANSI sequences or prefix)
      expect(firstItemLine).not.toEqual(secondItemLine);

      inst.unmount();
    });
  });
});

describe('InteractiveDocsSearch — narrow terminal width guard', () => {
  const LONG_URL =
    'https://mock-docs.test.qianwenai.com/developer-guides/some/very/deeply/nested/path/that-never-ends/getting-started-with-extremely-long-slugs';
  const LONG_TITLE =
    'An Extremely Long Documentation Title That Would Definitely Overflow A Narrow Terminal Window';
  const LONG_SUMMARY =
    'A very long summary that keeps going on and on well past the terminal width so it must be truncated to keep frame line accounting stable.';

  function makeWideVm(): DocsSearchViewModel {
    return makeVm({
      items: [
        makeItem({
          title: LONG_TITLE,
          highlightedTitle: `An Extremely Long Documentation <em>Title</em> That Would Definitely Overflow A Narrow Terminal Window`,
          url: LONG_URL,
          summary: LONG_SUMMARY,
          highlightedSummary: `A very long <em>summary that keeps going on and on well past the terminal width</em> so it must be truncated to keep frame line accounting stable.`,
          subBizType: 'Developer Guide',
        }),
      ],
      totalCount: 1,
    });
  }

  function wideFrame(): string {
    const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
    const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
    return frame(
      <InteractiveDocsSearch
        initialVm={makeWideVm()}
        loadPage={loadPage}
        fetchContent={fetchContent}
      />,
    );
  }

  it('caps every rendered line at 40 columns for long title/url/summary', () => {
    setTermSize(40, 20);
    const out = wideFrame();
    for (const line of out.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    // Over-wide lines are truncated with an ellipsis instead of wrapping.
    expect(out).toContain('\u2026');
  });

  it('truncates the long URL with an ellipsis at narrow width', () => {
    setTermSize(40, 20);
    const out = wideFrame();
    expect(out).not.toContain(LONG_URL);
    expect(out).toContain('https://mock-docs.test');
  });

  it('never leaks <em> markup even when the highlight crosses the truncation point', () => {
    setTermSize(40, 20);
    const out = wideFrame();
    expect(out).not.toContain('<em>');
    expect(out).not.toContain('</em>');
  });

  it('renders full content unchanged on a wide terminal (backward compatibility)', () => {
    setTermSize(200, 50);
    const out = wideFrame();
    expect(out).toContain(LONG_URL);
    expect(out).toContain(LONG_TITLE);
    expect(out).toContain(LONG_SUMMARY);
  });

  it('caps the degraded placeholder row at narrow width', () => {
    setTermSize(30, 20);
    const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
    const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
    const out = frame(
      <InteractiveDocsSearch
        initialVm={makeVm({
          items: [makeItem({ isDegraded: true })],
          totalCount: 1,
          degradedPlaceholder:
            'Search results schema is being aligned - a rather verbose placeholder message',
        })}
        loadPage={loadPage}
        fetchContent={fetchContent}
      />,
    );
    for (const line of out.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it('keeps every line within a 10-column terminal when the tag consumes the whole first-line budget', () => {
    // termCols=10 -> contentWidth=6, prefix width 2 -> lineBudget=4. A long
    // subBizType truncates to fill all 4 columns, so the title budget must
    // collapse to 0 (title hidden) instead of overflowing the line by 1.
    setTermSize(10, 20);
    const loadPage = vi.fn<(page: number) => Promise<DocsSearchViewModel>>();
    const fetchContent = vi.fn<(url: string) => Promise<DocContentViewModel>>();
    const out = frame(
      <InteractiveDocsSearch
        initialVm={makeVm({
          items: [
            makeItem({
              subBizType: 'Developer Guide Extended Edition',
              title: LONG_TITLE,
              highlightedTitle: `An Extremely Long Documentation <em>Title</em> That Would Definitely Overflow`,
              url: LONG_URL,
              summary: LONG_SUMMARY,
              highlightedSummary: `A very long <em>summary</em> that keeps going`,
            }),
          ],
          totalCount: 1,
        })}
        loadPage={loadPage}
        fetchContent={fetchContent}
      />,
    );
    for (const line of out.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
    expect(out).not.toContain('<em>');
    expect(out).not.toContain('</em>');
  });
});
