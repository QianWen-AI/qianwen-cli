import React, { useState, useEffect, useRef, useContext } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Section } from './Section.js';
import { AltScreenContext } from './render.js';
import { useTerminalSize } from './useTerminalSize.js';
import { truncateByDisplayWidth, visibleWidth } from './textWrap.js';
import { colors } from './theme.js';
import { DocsViewer } from './DocsViewer.js';
import { openBrowser } from '../utils/open-browser.js';
import type {
  DocsSearchViewModel,
  DocsSearchItemViewModel,
  DocContentViewModel,
} from '../view-models/docs/index.js';

export interface InteractiveDocsSearchProps {
  initialVm: DocsSearchViewModel;
  loadPage: (page: number) => Promise<DocsSearchViewModel>;
  fetchContent: (url: string) => Promise<DocContentViewModel>;
}

type Mode = 'list' | 'viewer';

const EM_TOKEN_RE = /(<em>[\s\S]*?<\/em>)/gi;
const EM_MATCH_RE = /^<em>([\s\S]*?)<\/em>$/i;

// Cap a highlighted value to `maxWidth` display columns. The <em> tags are
// invisible at render time, so truncating the raw string would spend budget
// on tag characters and over-truncate; walk the same token stream
// HighlightedText consumes, measure inner text only and re-close the tag
// when the cut lands inside a highlight. Isomorphic to DocsViewer's
// truncateMarkedLine (which is bound to its [BOLD]/[ITALIC] markup).
function truncateHighlighted(value: string, maxWidth: number): string {
  if (!value || maxWidth <= 0) return '';
  let out = '';
  let remaining = maxWidth;
  for (const token of value.split(EM_TOKEN_RE)) {
    if (!token || remaining <= 0) continue;
    const m = token.match(EM_MATCH_RE);
    const inner = m ? (m[1] ?? '') : token;
    const w = visibleWidth(inner);
    if (w <= remaining) {
      out += token;
      remaining -= w;
      continue;
    }
    const cut = truncateByDisplayWidth(inner, remaining);
    out += m ? `<em>${cut}</em>` : cut;
    break;
  }
  return out;
}

function HighlightedText({ value, maxWidth }: { value: string; maxWidth?: number }) {
  if (!value) return null;
  // A zero (or negative) budget means the tag already consumed the whole
  // line: render nothing so the first line never exceeds its budget.
  if (maxWidth != null && maxWidth <= 0) return null;
  const capped = maxWidth != null ? truncateHighlighted(value, maxWidth) : value;
  const parts = capped.split(EM_TOKEN_RE);
  return (
    <Text wrap="truncate-end">
      {parts.map((part, idx) => {
        const m = part.match(EM_MATCH_RE);
        if (m) {
          return (
            <Text key={idx} color={colors.accent} bold>
              {m[1]}
            </Text>
          );
        }
        return <Text key={idx}>{part}</Text>;
      })}
    </Text>
  );
}

function ResultRow({
  item,
  selected,
  placeholder,
  maxWidth,
  showUrl,
  showSummary,
  showSpacing,
}: {
  item: DocsSearchItemViewModel;
  selected: boolean;
  placeholder: string;
  maxWidth?: number;
  showUrl: boolean;
  showSummary: boolean;
  showSpacing: boolean;
}) {
  const prefix = selected ? '\u25B6 ' : '  ';
  const prefixColor = selected ? colors.brand : colors.muted;
  // First-line budget after the selection prefix; sub-lines (url/summary)
  // additionally lose their own paddingLeft={2}.
  const lineBudget = maxWidth != null ? Math.max(1, maxWidth - visibleWidth(prefix)) : undefined;
  const subBudget = maxWidth != null ? Math.max(1, maxWidth - 2) : undefined;

  if (item.isDegraded) {
    return (
      <Box>
        <Text color={prefixColor} wrap="truncate-end">
          {prefix}
        </Text>
        <Text color={colors.muted} wrap="truncate-end">
          {lineBudget != null ? truncateByDisplayWidth(placeholder, lineBudget) : placeholder}
        </Text>
      </Box>
    );
  }

  const rawTag = item.subBizType ? `${item.subBizType} ` : '';
  const tag = lineBudget != null && rawTag ? truncateByDisplayWidth(rawTag, lineBudget) : rawTag;
  // Tag wins the budget contest: when it fills the whole line the title
  // budget drops to 0 (title hidden) instead of being floored to 1, which
  // would push the first line one column past contentWidth and physically
  // wrap on very narrow terminals.
  let titleBudget: number | undefined;
  if (lineBudget != null) {
    const remaining = lineBudget - visibleWidth(tag);
    titleBudget = remaining > 0 ? remaining : 0;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? colors.brand : prefixColor} bold={selected} wrap="truncate-end">
          {prefix}
        </Text>
        {tag ? (
          <Text
            color={selected ? colors.headerFg : colors.muted}
            backgroundColor={selected ? colors.headerBg : undefined}
            wrap="truncate-end"
          >
            {tag}
          </Text>
        ) : null}
        <Text
          color={selected ? colors.headerFg : undefined}
          bold={selected}
          backgroundColor={selected ? colors.headerBg : undefined}
          wrap="truncate-end"
        >
          <HighlightedText value={item.highlightedTitle || item.title} maxWidth={titleBudget} />
        </Text>
      </Box>
      {showUrl && item.url ? (
        <Box paddingLeft={2}>
          <Text color={colors.muted} wrap="truncate-end">
            {subBudget != null ? truncateByDisplayWidth(item.url, subBudget) : item.url}
          </Text>
        </Box>
      ) : null}
      {showSummary && selected && item.summary ? (
        <Box paddingLeft={2}>
          <HighlightedText value={item.highlightedSummary || item.summary} maxWidth={subBudget} />
        </Box>
      ) : null}
      {showSpacing && <Text> </Text>}
    </Box>
  );
}

export function InteractiveDocsSearch({
  initialVm,
  loadPage,
  fetchContent,
}: InteractiveDocsSearchProps) {
  const { exit } = useApp();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const inAltScreen = useContext(AltScreenContext);

  const [mode, setMode] = useState<Mode>('list');
  const [page, setPage] = useState<number>(initialVm.page);
  const [vm, setVm] = useState<DocsSearchViewModel>(initialVm);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [contentVm, setContentVm] = useState<DocContentViewModel | null>(null);
  const [contentLoading, setContentLoading] = useState<boolean>(false);
  const [activeUrl, setActiveUrl] = useState<string>('');

  const pageCacheRef = useRef<Map<number, DocsSearchViewModel>>(new Map());
  const initializedRef = useRef(false);
  const stableFooterRef = useRef('');
  if (!initializedRef.current) {
    pageCacheRef.current.set(initialVm.page, initialVm);
    initializedRef.current = true;
  }

  useEffect(() => {
    let cancelled = false;
    const cache = pageCacheRef.current;

    if (cache.has(page)) {
      const cached = cache.get(page)!;
      setVm(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    loadPage(page)
      .then((newVm) => {
        if (cancelled) return;
        cache.set(page, newVm);
        setVm(newVm);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, loadPage]);

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      exit();
      return;
    }

    if (mode !== 'list') return;
    if (loading || contentLoading) return;

    if (input === 'q' || key.escape) {
      exit();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(Math.max(0, vm.items.length - 1), i + 1));
      return;
    }
    if ((key.leftArrow || input === 'p') && page > 1) {
      setSelectedIndex(0);
      setPage((p) => p - 1);
      return;
    }
    if ((key.rightArrow || input === 'n') && page < vm.pageCount) {
      setSelectedIndex(0);
      setPage((p) => p + 1);
      return;
    }
    if (input === 'o') {
      const item = vm.items[selectedIndex];
      if (item && !item.isDegraded && item.url) void openBrowser(item.url);
      return;
    }
    if (key.return) {
      const item = vm.items[selectedIndex];
      if (!item || item.isDegraded || !item.url) return;
      const url = item.url;
      setActiveUrl(url);
      setContentLoading(true);
      fetchContent(url)
        .then((cvm) => {
          setContentVm(cvm);
          setContentLoading(false);
          setMode('viewer');
        })
        .catch(() => {
          setContentLoading(false);
        });
      return;
    }
  });

  if (mode === 'viewer' && contentVm) {
    return (
      <DocsViewer
        vm={contentVm}
        url={activeUrl}
        onBack={() => {
          setMode('list');
          setContentVm(null);
        }}
        onQuit={() => exit()}
      />
    );
  }

  const subtitle = `"${vm.query}"  Total: ${vm.totalCount}`;
  const currentFooter = `Page ${vm.page}/${vm.pageCount}  \u2191/\u2193 select  \u2190/\u2192 page  Enter: view  o: open  q: quit`;
  if (!loading) {
    stableFooterRef.current = currentFooter;
  }
  const footer = stableFooterRef.current || currentFooter;

  const useWindowsMainScreen = process.platform === 'win32' && !inAltScreen;
  // Windows main-screen views intentionally fill the terminal so Ink uses its
  // full repaint path during resize. Other main-screen callers keep their
  // natural height; alt-screen views stay below the clearTerminal threshold.
  const safeMinHeight = inAltScreen
    ? Math.max(1, termRows - 1)
    : useWindowsMainScreen
      ? termRows
      : undefined;
  const frameWidth = termCols;
  // Width budget for result rows: Section paddingLeft (2) + list Box
  // paddingLeft (2). Recomputed on resize via useTerminalSize so every logical
  // line stays <= terminal columns and never physically wraps.
  const contentWidth = Math.max(1, frameWidth - 4);
  // Reserve the section header, separator, and footer. Oversized frames enter
  // Ink's clearTerminal path, which the alternate-screen renderer suppresses.
  const contentRows = Math.max(1, termRows - (inAltScreen ? 1 : 0) - 3);
  const showUrl = contentRows >= 2;
  const showSummary = contentRows >= 3;
  const showSpacing = contentRows >= 4;
  const itemRows = 1 + Number(showUrl) + Number(showSpacing);
  const visibleCount = Math.max(1, Math.floor((contentRows - Number(showSummary)) / itemRows));
  const visibleStart = Math.max(0, selectedIndex - visibleCount + 1);
  const visibleItems = vm.items.slice(visibleStart, visibleStart + visibleCount);

  if (vm.isEmpty) {
    return (
      <Box flexDirection="column" width={frameWidth} minHeight={safeMinHeight}>
        <Section
          title="Documentation Search"
          subtitle={subtitle}
          footer={footer}
          maxWidth={frameWidth}
        >
          <Box paddingLeft={2}>
            <Text color={colors.muted} wrap="truncate-end">
              No results.
            </Text>
          </Box>
        </Section>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={frameWidth} minHeight={safeMinHeight}>
      <Section
        title="Documentation Search"
        subtitle={subtitle}
        footer={footer}
        maxWidth={frameWidth}
      >
        {loading && vm.items.length === 0 ? (
          <Box paddingLeft={2}>
            <Text color={colors.muted} wrap="truncate-end">
              Loading...
            </Text>
          </Box>
        ) : contentLoading ? (
          <Box paddingLeft={2}>
            <Text color={colors.muted} wrap="truncate-end">
              Fetching document...
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column" paddingLeft={2}>
            {visibleItems.map((item, idx) => (
              <ResultRow
                key={visibleStart + idx}
                item={item}
                selected={visibleStart + idx === selectedIndex}
                placeholder={vm.degradedPlaceholder}
                maxWidth={contentWidth}
                showUrl={showUrl}
                showSummary={showSummary}
                showSpacing={showSpacing}
              />
            ))}
          </Box>
        )}
      </Section>
    </Box>
  );
}
