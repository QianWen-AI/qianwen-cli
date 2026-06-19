/**
 * Docs search view-model — handles partial / degraded responses gracefully:
 * a row is degraded when either `title` or `url` is missing; once at least
 * 50% of items are degraded the whole result carries a top-level diagnostic
 * marker that the renderer surfaces as a single user-visible banner.
 *
 * `<em>` highlight tags are preserved on highlighted* fields so renderers
 * can re-style them; the plain `title` / `summary` fields are cleaned of
 * tags so plain-text rendering does not leak markup.
 */

import type { DocsSearchResponse, DocsSearchItem, DocContentResult } from '../../types/docs.js';

const EM_DASH = '\u2014';
const DEGRADATION_DIAGNOSTIC = 'search.fields_incomplete';
const DEGRADATION_RATIO_THRESHOLD = 0.5;
const DEGRADED_PLACEHOLDER_EN = 'Search results schema is being aligned';
const DEGRADED_PLACEHOLDER_ZH = '搜索服务结果字段对齐中';

export interface DocsSearchItemViewModel {
  index: number; // 1-based position across all pages
  title: string; // tag-stripped, falls back to placeholder when degraded
  highlightedTitle: string; // raw, may contain <em> tags
  subBizType: string;
  url: string;
  summary: string; // tag-stripped
  highlightedSummary: string;
  breadcrumb: string[];
  isDegraded: boolean;
}

export interface DocsSearchViewModel {
  query: string;
  totalCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
  items: DocsSearchItemViewModel[];
  diagnostics: string[];
  isEmpty: boolean;
  isAllDegraded: boolean;
  degradedPlaceholder: string;
}

export interface BuildDocsSearchOptions {
  query: string;
  page: number;
  pageSize: number;
  language?: 'en' | 'zh';
}

export function buildDocsSearchViewModel(
  data: DocsSearchResponse,
  options: BuildDocsSearchOptions,
): DocsSearchViewModel {
  const language = options.language ?? 'en';
  const placeholder = language === 'zh' ? DEGRADED_PLACEHOLDER_ZH : DEGRADED_PLACEHOLDER_EN;
  const pageSize = data.pageSize > 0 ? data.pageSize : options.pageSize;

  const items = data.items.map((item, i) =>
    toItem(item, placeholder, (data.page - 1) * pageSize + i + 1),
  );

  const degradedCount = items.filter((it) => it.isDegraded).length;
  const total = items.length;
  const diagnostics: string[] = [];
  if (total > 0 && degradedCount / total >= DEGRADATION_RATIO_THRESHOLD) {
    diagnostics.push(DEGRADATION_DIAGNOSTIC);
  }

  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(data.totalCount / pageSize)) : 1;

  return {
    query: options.query,
    totalCount: data.totalCount,
    page: data.page,
    pageSize: data.pageSize,
    pageCount,
    items,
    diagnostics,
    isEmpty: items.length === 0,
    isAllDegraded: total > 0 && degradedCount === total,
    degradedPlaceholder: placeholder,
  };
}

function toItem(item: DocsSearchItem, placeholder: string, index: number): DocsSearchItemViewModel {
  const isDegraded = isItemDegraded(item);
  return {
    index,
    title: isDegraded ? placeholder : stripEmTags(item.title) || EM_DASH,
    highlightedTitle: item.highlightedTitle,
    subBizType: item.subBizType || EM_DASH,
    url: item.url || EM_DASH,
    summary: stripEmTags(item.summary),
    highlightedSummary: item.highlightedSummary,
    breadcrumb: item.breadcrumb,
    isDegraded,
  };
}

function isItemDegraded(item: DocsSearchItem): boolean {
  const hasTitle = typeof item.title === 'string' && item.title.length > 0;
  const hasUrl = typeof item.url === 'string' && item.url.length > 0;
  return !(hasTitle && hasUrl);
}

export function stripEmTags(value: string): string {
  if (!value) return '';
  return value.replace(/<\/?em>/gi, '');
}

// ────────────────────────────────────────────────────────────────────
// Doc content view-model
// ────────────────────────────────────────────────────────────────────

export interface DocContentViewModel {
  url: string;
  resolvedMarkdownUrl: string;
  content: string | null;
  renderedLines: string[] | null;
  error: string | null;
  anchor: string | null;
  anchorLine: number | null;
}

export function buildDocContentViewModel(result: DocContentResult): DocContentViewModel {
  if (result.content === null) {
    return {
      url: result.url,
      resolvedMarkdownUrl: result.resolvedMarkdownUrl,
      content: null,
      renderedLines: null,
      error: result.error,
      anchor: result.anchor,
      anchorLine: null,
    };
  }

  let renderedLines: string[] | null;
  try {
    renderedLines = parseMarkdownLines(result.content);
  } catch {
    renderedLines = null;
  }

  const anchorLine = resolveAnchorLine(renderedLines, result.anchor);

  return {
    url: result.url,
    resolvedMarkdownUrl: result.resolvedMarkdownUrl,
    content: result.content,
    renderedLines,
    error: null,
    anchor: result.anchor,
    anchorLine,
  };
}

function parseMarkdownLines(raw: string): string[] {
  const lines = raw.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      output.push(`[CODE] ${line}`);
      continue;
    }

    if (line.startsWith('### ') || line.match(/^#{4,} /)) {
      output.push(`[H3] ${line.replace(/^#+\s*/, '')}`);
    } else if (line.startsWith('## ')) {
      output.push(`[H2] ${line.slice(3)}`);
    } else if (line.startsWith('# ')) {
      output.push(`[H1] ${line.slice(2)}`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      output.push(`[LIST] ${line.replace(/^\s*[-*]\s+/, '')}`);
    } else {
      output.push(formatInline(line));
    }
  }
  return output;
}

function formatInline(line: string): string {
  let result = line;
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  result = result.replace(/\*\*(.+?)\*\*/g, '[BOLD]$1[/BOLD]');
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '[ITALIC]$1[/ITALIC]');
  return result;
}

function resolveAnchorLine(lines: string[] | null, anchor: string | null): number | null {
  if (!lines || !anchor) return null;
  const normalizedAnchor = anchor
    .replace(/-/g, ' ')
    .toLowerCase()
    .replace(/[^\w\s]/g, '');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('[H1] ') || line.startsWith('[H2] ') || line.startsWith('[H3] ')) {
      const headingText = line.replace(/^\[H[123]\]\s*/, '');
      const normalizedHeading = headingText.toLowerCase().replace(/[^\w\s]/g, '');
      if (normalizedHeading.includes(normalizedAnchor)) {
        return i;
      }
    }
  }
  return null;
}
