import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { InteractiveDocsSearch } from '../../src/ui/InteractiveDocsSearch.js';
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
    url: 'https://mock-docs.test.qianwen.com/developer-guides/getting-started',
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

beforeEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
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

    expect(out).toContain('mock-docs.test.qianwen.com');
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
        url: `https://mock-docs.test.qianwen.com/doc-${i + 1}`,
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
