import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Section } from './Section.js';
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

function HighlightedText({ value }: { value: string }) {
  if (!value) return null;
  const parts = value.split(/(<em>[\s\S]*?<\/em>)/gi);
  return (
    <Text>
      {parts.map((part, idx) => {
        const m = part.match(/^<em>([\s\S]*?)<\/em>$/i);
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
}: {
  item: DocsSearchItemViewModel;
  selected: boolean;
  placeholder: string;
}) {
  const prefix = selected ? '\u25B6 ' : '  ';
  const prefixColor = selected ? colors.brand : colors.muted;

  if (item.isDegraded) {
    return (
      <Box>
        <Text color={prefixColor}>{prefix}</Text>
        <Text color={colors.muted}>{placeholder}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? colors.brand : prefixColor} bold={selected}>
          {prefix}
        </Text>
        {item.subBizType ? (
          <Text
            color={selected ? colors.headerFg : colors.muted}
            backgroundColor={selected ? colors.headerBg : undefined}
          >
            {item.subBizType}{' '}
          </Text>
        ) : null}
        <Text
          color={selected ? colors.headerFg : undefined}
          bold={selected}
          backgroundColor={selected ? colors.headerBg : undefined}
        >
          <HighlightedText value={item.highlightedTitle || item.title} />
        </Text>
      </Box>
      {item.url ? (
        <Box paddingLeft={2}>
          <Text color={colors.muted}>{item.url}</Text>
        </Box>
      ) : null}
      {selected && item.summary ? (
        <Box paddingLeft={2}>
          <HighlightedText value={item.highlightedSummary || item.summary} />
        </Box>
      ) : null}
      <Text> </Text>
    </Box>
  );
}

export function InteractiveDocsSearch({
  initialVm,
  loadPage,
  fetchContent,
}: InteractiveDocsSearchProps) {
  const { exit } = useApp();

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
      if (item && !item.isDegraded && item.url) openBrowser(item.url);
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

  if (vm.isEmpty) {
    return (
      <Section title="Documentation Search" subtitle={subtitle} footer={footer}>
        <Box paddingLeft={2}>
          <Text color={colors.muted}>No results.</Text>
        </Box>
      </Section>
    );
  }

  return (
    <Section title="Documentation Search" subtitle={subtitle} footer={footer}>
      {loading && vm.items.length === 0 ? (
        <Box paddingLeft={2}>
          <Text color={colors.muted}>Loading...</Text>
        </Box>
      ) : contentLoading ? (
        <Box paddingLeft={2}>
          <Text color={colors.muted}>Fetching document...</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={2}>
          {vm.items.map((item, idx) => (
            <ResultRow
              key={idx}
              item={item}
              selected={idx === selectedIndex}
              placeholder={vm.degradedPlaceholder}
            />
          ))}
        </Box>
      )}
    </Section>
  );
}
