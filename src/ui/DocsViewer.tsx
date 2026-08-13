import React, { useState, useMemo, useContext } from 'react';
import { Box, Text, useInput } from 'ink';
import { Section } from './Section.js';
import { colors } from './theme.js';
import { openBrowser } from '../utils/open-browser.js';
import { truncateByDisplayWidth, visibleWidth } from './textWrap.js';
import { useTerminalSize } from './useTerminalSize.js';
import { AltScreenContext } from './render.js';
import type { DocContentViewModel } from '../view-models/docs/index.js';

export interface DocsViewerProps {
  vm: DocContentViewModel;
  url: string;
  onBack: () => void;
  onQuit: () => void;
}

const FIXED_CHROME_LINES = 5;

function extractDomain(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function deriveTitle(lines: string[] | null, url: string): string {
  if (lines) {
    for (const line of lines) {
      if (line.startsWith('[H1] ')) return line.slice(5);
    }
    for (const line of lines) {
      if (line.startsWith('[H2] ')) return line.slice(5);
    }
  }
  return extractDomain(url);
}

const INLINE_MARK_RE = /(\[BOLD\][\s\S]*?\[\/BOLD\]|\[ITALIC\][\s\S]*?\[\/ITALIC\])/g;

function renderInlineMarks(text: string, baseKey: string): React.ReactNode {
  const tokens = text.split(INLINE_MARK_RE);
  return tokens.map((token, idx) => {
    const boldMatch = token.match(/^\[BOLD\]([\s\S]*?)\[\/BOLD\]$/);
    if (boldMatch) {
      return (
        <Text key={`${baseKey}-b-${idx}`} bold>
          {boldMatch[1]}
        </Text>
      );
    }
    const italicMatch = token.match(/^\[ITALIC\]([\s\S]*?)\[\/ITALIC\]$/);
    if (italicMatch) {
      return (
        <Text key={`${baseKey}-i-${idx}`} dimColor>
          {italicMatch[1]}
        </Text>
      );
    }
    return <Text key={`${baseKey}-t-${idx}`}>{token}</Text>;
  });
}

// Cap a marked-up paragraph line to `maxWidth` display columns. The
// [BOLD]/[ITALIC] markers are invisible at render time, so truncating the raw
// string would spend budget on marker characters and over-truncate; walk the
// same token stream renderInlineMarks consumes and measure inner text only.
function truncateMarkedLine(line: string, maxWidth: number): string {
  let out = '';
  let remaining = maxWidth;
  for (const token of line.split(INLINE_MARK_RE)) {
    if (!token || remaining <= 0) continue;
    const mark = token.match(/^\[(BOLD|ITALIC)\]([\s\S]*?)\[\/\1\]$/);
    const inner = mark ? (mark[2] ?? '') : token;
    const w = visibleWidth(inner);
    if (w <= remaining) {
      out += token;
      remaining -= w;
      continue;
    }
    const cut = truncateByDisplayWidth(inner, remaining);
    out += mark ? `[${mark[1]}]${cut}[/${mark[1]}]` : cut;
    break;
  }
  return out;
}

function MarkdownLine({
  line,
  index,
  maxWidth,
}: {
  line: string;
  index: number;
  maxWidth: number;
}) {
  const key = `line-${index}`;
  // Empty lines must output at least one space so Yoga measures height = 1;
  // measureText('') returns height 0 and breaks total-output-height accounting.
  if (!line) return <Text key={key}> </Text>;
  // Every branch hard-caps the visible width via truncateByDisplayWidth: a
  // logical line wider than the terminal physically wraps, desyncing Ink's
  // logical-line-count frame erasure (same root cause as the InteractiveTable
  // resize corruption). Ink's own wrap="truncate-end" stays as a backstop, but
  // it measures with string-width, which under-counts ZWJ emoji on xterm.js —
  // our visibleWidth-based truncation is the authoritative cap.
  if (line.startsWith('[H1] ')) {
    return (
      <Text bold color={colors.brand} wrap="truncate-end">
        {truncateByDisplayWidth(line.slice(5), maxWidth)}
      </Text>
    );
  }
  if (line.startsWith('[H2] ')) {
    return (
      <Text bold wrap="truncate-end">
        {truncateByDisplayWidth(line.slice(5), maxWidth)}
      </Text>
    );
  }
  if (line.startsWith('[H3] ')) {
    return (
      <Text underline wrap="truncate-end">
        {truncateByDisplayWidth(line.slice(5), maxWidth)}
      </Text>
    );
  }
  if (line.startsWith('[CODE] ')) {
    return (
      <Text backgroundColor={colors.codeBg} color={colors.codeFg} wrap="truncate-end">
        {truncateByDisplayWidth(line.slice(7) || ' ', maxWidth)}
      </Text>
    );
  }
  if (line.startsWith('[LIST] ')) {
    return (
      <Text wrap="truncate-end">
        {truncateByDisplayWidth(`  \u2022 ${line.slice(7)}`, maxWidth)}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">{renderInlineMarks(truncateMarkedLine(line, maxWidth), key)}</Text>
  );
}

export function DocsViewer({ vm, url, onBack, onQuit }: DocsViewerProps) {
  const { columns, rows } = useTerminalSize();
  const inAltScreen = useContext(AltScreenContext);
  // Width budget for content lines: Section paddingLeft (2) + content Box
  // paddingLeft (2). Recomputed on resize via useTerminalSize so every logical
  // line stays <= terminal columns and never physically wraps.
  const contentWidth = Math.max(1, columns - 4);
  // On the alt-screen, keep the total rendered height strictly below `rows`.
  // Ink switches to its clearTerminal path when output height >= rows (see
  // ink: `outputHeight >= stdout.rows`), and that path emits \x1b[2J\x1b[3J\x1b[H
  // — the \x1b[3J wipes terminal scrollback on Terminal.app/iTerm2. Reserving one
  // row keeps Ink on plain line-redraws, so the scrollback (the user's command
  // history) survives. On tiny terminals the floor compresses to 1 (not 5):
  // a fixed floor would push chrome + content back to >= rows and re-trigger
  // clearTerminal on every frame. Off the alt-screen the floor of 5 stays.
  const viewHeight = inAltScreen
    ? Math.max(1, rows - FIXED_CHROME_LINES - 1)
    : Math.max(5, rows - FIXED_CHROME_LINES);

  const lines = useMemo<string[]>(() => {
    if (vm.renderedLines && vm.renderedLines.length > 0) return vm.renderedLines;
    if (vm.content) return vm.content.split('\n');
    return [];
  }, [vm.renderedLines, vm.content]);

  const totalLines = lines.length;
  const maxOffset = Math.max(0, totalLines - viewHeight);

  const [scrollOffset, setScrollOffset] = useState<number>(0);

  const title = useMemo(() => deriveTitle(vm.renderedLines, url), [vm.renderedLines, url]);
  const domain = useMemo(() => extractDomain(url), [url]);

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      onQuit();
      return;
    }
    if (input === 'q') {
      onQuit();
      return;
    }
    if (input === 'f' && key.ctrl) {
      setScrollOffset((o) => Math.min(maxOffset, o + viewHeight));
      return;
    }
    if (input === 'b' && key.ctrl) {
      setScrollOffset((o) => Math.max(0, o - viewHeight));
      return;
    }
    if (input === 'b' || key.escape) {
      onBack();
      return;
    }
    if (input === 'o') {
      void openBrowser(url);
      return;
    }
    if (key.upArrow && key.shift) {
      setScrollOffset((o) => Math.max(0, o - viewHeight));
      return;
    }
    if (key.pageUp) {
      setScrollOffset((o) => Math.max(0, o - viewHeight));
      return;
    }
    if (key.pageDown || input === ' ') {
      setScrollOffset((o) => Math.min(maxOffset, o + viewHeight));
      return;
    }
    if (key.upArrow) {
      setScrollOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((o) => Math.min(maxOffset, o + 1));
      return;
    }
    if (input === 'g') {
      setScrollOffset(0);
      return;
    }
    if (input === 'G') {
      setScrollOffset(maxOffset);
      return;
    }
  });

  if (vm.content == null) {
    // Error/URL lines keep Ink's default wrap: folding into multiple logical
    // lines is safe (logical = physical) and preserves the full message.
    return (
      <Section title={title} subtitle={domain} footer="b: back   q: quit" maxWidth={columns}>
        <Box paddingLeft={2} flexDirection="column">
          <Text color={colors.muted}>
            {truncateByDisplayWidth('\u2190 Back to results (press b)', contentWidth)}
          </Text>
          <Text> </Text>
          <Text color={colors.error}>Failed to load document.</Text>
          {vm.error ? <Text color={colors.muted}>{vm.error}</Text> : null}
          <Text color={colors.muted}>{url}</Text>
        </Box>
      </Section>
    );
  }

  const clampedScrollOffset = Math.min(scrollOffset, maxOffset);
  const visible = lines.slice(clampedScrollOffset, clampedScrollOffset + viewHeight);
  const position = totalLines === 0 ? '[0/0]' : `[${clampedScrollOffset + 1}/${totalLines}]`;
  const footer = `\u2191\u2193 scroll  PgUp/Dn page  g/G top/end  o open  b back  q quit ${position}`;

  // Padding lives outside Section as a direct child of the root Box. Each
  // padding row uses a single space so Yoga measures height = 1.
  const contentLines = Math.min(visible.length, viewHeight);
  const totalRendered = FIXED_CHROME_LINES + contentLines;
  // On the alt-screen the buffer switch guarantees a clean exit, so we must NOT
  // pad to full height: that pushes Ink into its clearTerminal path, whose
  // \x1b[3J wipes the terminal scrollback on Terminal.app/iTerm2. Off the
  // alt-screen (e.g. ConHost) keep the padding so the redraw clears residue.
  const padLines = inAltScreen ? 0 : Math.max(0, rows - totalRendered);

  return (
    <Box flexDirection="column">
      <Section title={title} subtitle={domain} footer={footer} maxWidth={columns}>
        <Box paddingLeft={2} flexDirection="column">
          <Text color={colors.muted} wrap="truncate-end">
            {truncateByDisplayWidth('\u2190 Back to results (press b)', contentWidth)}
          </Text>
        </Box>
        <Box paddingLeft={2} flexDirection="column" marginTop={1}>
          {visible.length === 0 ? (
            <Text color={colors.muted} wrap="truncate-end">
              (empty document)
            </Text>
          ) : (
            visible.map((line, idx) => (
              <MarkdownLine
                key={`${clampedScrollOffset}-${idx}`}
                line={line}
                index={clampedScrollOffset + idx}
                maxWidth={contentWidth}
              />
            ))
          )}
        </Box>
      </Section>
      {Array.from({ length: padLines }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </Box>
  );
}
