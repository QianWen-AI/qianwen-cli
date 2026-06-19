import { describe, it, expect } from 'vitest';
import {
  buildDocsSearchViewModel,
  buildDocContentViewModel,
  stripEmTags,
} from '../../../src/view-models/docs/search.js';
import type { DocsSearchResponse, DocContentResult } from '../../../src/types/docs.js';

const makeItem = (overrides: Partial<DocsSearchResponse['items'][number]> = {}) => ({
  title: 't',
  highlightedTitle: 't',
  subBizType: 'guide',
  url: 'https://docs.test.qianwen.com/x',
  summary: 's',
  highlightedSummary: 's',
  breadcrumb: [],
  ...overrides,
});

const makeResponse = (overrides: Partial<DocsSearchResponse> = {}): DocsSearchResponse => ({
  totalCount: 0,
  page: 1,
  pageSize: 10,
  items: [],
  ...overrides,
});

describe('stripEmTags', () => {
  it('removes <em> and </em> tags case-insensitively', () => {
    expect(stripEmTags('hello <em>world</em>')).toBe('hello world');
    expect(stripEmTags('<EM>foo</EM>')).toBe('foo');
  });

  it('returns empty string for falsy input', () => {
    expect(stripEmTags('')).toBe('');
  });

  it('leaves other tags intact (only strips em)', () => {
    expect(stripEmTags('<b>x</b><em>y</em>')).toBe('<b>x</b>y');
  });
});

describe('buildDocsSearchViewModel', () => {
  it('strips em tags from title and summary; preserves highlighted variants', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse({
        totalCount: 1,
        items: [
          makeItem({
            title: '<em>Quick</em> start',
            highlightedTitle: '<em>Quick</em> start',
            summary: 'Use <em>API</em>',
            highlightedSummary: 'Use <em>API</em>',
          }),
        ],
      }),
      { query: 'quick', page: 1, pageSize: 10 },
    );
    expect(vm.items[0].title).toBe('Quick start');
    expect(vm.items[0].highlightedTitle).toBe('<em>Quick</em> start');
    expect(vm.items[0].summary).toBe('Use API');
    expect(vm.items[0].highlightedSummary).toBe('Use <em>API</em>');
  });

  it('marks items as degraded when title or url is missing', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse({
        totalCount: 2,
        items: [
          makeItem({ title: '', url: 'https://docs.test.qianwen.com/a' }),
          makeItem({ title: 'OK', url: 'https://docs.test.qianwen.com/b' }),
        ],
      }),
      { query: 'q', page: 1, pageSize: 10 },
    );
    expect(vm.items[0].isDegraded).toBe(true);
    expect(vm.items[1].isDegraded).toBe(false);
  });

  it('emits diagnostic when degraded ratio reaches 50%', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse({
        totalCount: 2,
        items: [
          makeItem({ url: '' }), // degraded
          makeItem({ title: 'OK' }),
        ],
      }),
      { query: 'q', page: 1, pageSize: 10 },
    );
    expect(vm.diagnostics).toContain('search.fields_incomplete');
  });

  it('does not emit diagnostic when below threshold', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse({
        totalCount: 4,
        items: [
          makeItem({ url: '' }), // 1 degraded out of 4 = 25%
          makeItem(),
          makeItem(),
          makeItem(),
        ],
      }),
      { query: 'q', page: 1, pageSize: 10 },
    );
    expect(vm.diagnostics).toEqual([]);
  });

  it('uses Chinese degraded placeholder when language=zh', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse({ items: [makeItem({ title: '', url: '' })], totalCount: 1 }),
      { query: 'q', page: 1, pageSize: 10, language: 'zh' },
    );
    expect(vm.degradedPlaceholder).toBe('搜索服务结果字段对齐中');
    expect(vm.items[0].title).toBe('搜索服务结果字段对齐中');
    expect(vm.isAllDegraded).toBe(true);
  });

  it('computes 1-based index across pages', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse({
        page: 3,
        pageSize: 10,
        totalCount: 30,
        items: [makeItem(), makeItem()],
      }),
      { query: 'q', page: 3, pageSize: 10 },
    );
    expect(vm.items[0].index).toBe(21);
    expect(vm.items[1].index).toBe(22);
  });

  it('returns isEmpty=true when no items', () => {
    const vm = buildDocsSearchViewModel(makeResponse({ totalCount: 0 }), {
      query: 'nope',
      page: 1,
      pageSize: 10,
    });
    expect(vm.isEmpty).toBe(true);
    expect(vm.diagnostics).toEqual([]);
    expect(vm.isAllDegraded).toBe(false);
  });

  it('substitutes em-dash for empty subBizType and url on a non-degraded item', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse({
        totalCount: 1,
        items: [makeItem({ title: 'x', url: 'u', subBizType: '' })],
      }),
      { query: 'q', page: 1, pageSize: 10 },
    );
    expect(vm.items[0].subBizType).toBe('—');
  });

  it('computes pageCount from totalCount and pageSize', () => {
    const vm = buildDocsSearchViewModel(
      makeResponse({
        totalCount: 25,
        pageSize: 10,
        items: [makeItem()],
      }),
      { query: 'q', page: 1, pageSize: 10 },
    );
    expect(vm.pageCount).toBe(3);
  });
});

describe('buildDocContentViewModel', () => {
  const make = (overrides: Partial<DocContentResult> = {}): DocContentResult => ({
    url: 'https://docs.test.qianwen.com/page',
    resolvedMarkdownUrl: 'https://docs.test.qianwen.com/page.md',
    content: null,
    error: null,
    anchor: null,
    ...overrides,
  });

  it('returns error result with null renderedLines when content is null', () => {
    const vm = buildDocContentViewModel(make({ content: null, error: 'fetch failed' }));
    expect(vm.renderedLines).toBeNull();
    expect(vm.content).toBeNull();
    expect(vm.error).toBe('fetch failed');
    expect(vm.anchorLine).toBeNull();
  });

  it('parses markdown headers, lists, and code blocks', () => {
    const md = ['# Title', '## Section', 'plain', '- item one', '```', 'code', '```'].join('\n');
    const vm = buildDocContentViewModel(make({ content: md }));
    expect(vm.renderedLines).toEqual([
      '[H1] Title',
      '[H2] Section',
      'plain',
      '[LIST] item one',
      '[CODE] code',
    ]);
  });

  it('locates anchor line within parsed headings', () => {
    const md = ['# Intro', '## Quick Start', 'body'].join('\n');
    const vm = buildDocContentViewModel(make({ content: md, anchor: 'quick-start' }));
    expect(vm.anchorLine).toBe(1);
  });

  it('returns null anchorLine when anchor not found', () => {
    const vm = buildDocContentViewModel(make({ content: '# Hello', anchor: 'nowhere' }));
    expect(vm.anchorLine).toBeNull();
  });

  it('formats inline links and bold text', () => {
    const vm = buildDocContentViewModel(
      make({ content: 'See [docs](https://x) and **bold** text' }),
    );
    expect(vm.renderedLines).toEqual(['See docs and [BOLD]bold[/BOLD] text']);
  });
});
