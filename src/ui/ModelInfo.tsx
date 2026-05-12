import React from 'react';
import { Text } from 'ink';
import { Card, CardLine, Section as CardSection } from './Card.js';
import { theme, colors, buildProgressBar } from './theme.js';
import { wrapTextWithIndent, visibleWidth, padEndVisible } from './textWrap.js';
import { renderWithInk } from './render.js';
import type {
  ModelDetailViewModel,
  PricingLineViewModel,
  BuiltInToolViewModel,
} from '../view-models/models.js';

export interface ModelInfoInkProps {
  vm: ModelDetailViewModel;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Column divider for inline tables — dark purple ` │ ` (matches Table.tsx) */
const COL_DIV = theme.border(' │ ');

/** Pad a chalk-colored string to a visual width. */
function padColored(s: string, w: number): string {
  const visual = visibleWidth(s);
  return s + ' '.repeat(Math.max(0, w - visual));
}

/** Compute max visible width across an array of strings. */
function maxVisibleWidth(items: string[], min: number): number {
  return Math.max(min, ...items.map((s) => visibleWidth(s)));
}

/** Build a separator row: col widths joined with ─┼─, padded with ─ to innerWidth. */
function buildSep(colWidths: number[], innerWidth: number): string {
  const raw = colWidths
    .map((w) => '─'.repeat(w))
    .join('─┼─')
    .padEnd(innerWidth, '─');
  return theme.border(raw);
}

/** Build a mini progress bar string (detail card uses wider bar). */
const progressBar = (pct: number) => buildProgressBar(pct, 22);

/** Build a key-value label string: muted label padded + plain value. */
function kv(label: string, value: string, labelWidth: number): string {
  return theme.label(label.padEnd(labelWidth)) + value;
}

// ── Main Component ────────────────────────────────────────────────────────────

/**
 * Ink React component for model detail display.
 * Consumes ModelDetailViewModel — pure presentation, no API/data logic.
 */
export function ModelInfoInk({ vm }: ModelInfoInkProps) {
  const paddingLeft = 2;
  const terminalWidth = Math.max(20, process.stdout.columns ?? 80);
  const w = Math.max(20, Math.min(terminalWidth - paddingLeft, 80));
  const innerWidth = Math.max(0, w - 6);

  return (
    <Card title={vm.id} width={w}>
      {/* Metadata — first section, its ├──┤ serves as card title separator */}
      <CardSection title="Metadata" width={w}>
        {vm.metadata.category && (
          <CardLine width={w}>
            <Text>{kv('Category', vm.metadata.category, 13)}</Text>
          </CardLine>
        )}
        <CardLine width={w}>
          <Text>{kv('Version', vm.metadata.version, 13)}</Text>
        </CardLine>
        {vm.metadata.snapshot && (
          <CardLine width={w}>
            <Text>{kv('Snapshot', vm.metadata.snapshot, 13)}</Text>
          </CardLine>
        )}
        <CardLine width={w}>
          <Text>{kv('Open Source', vm.metadata.openSource, 13)}</Text>
        </CardLine>
        <CardLine width={w}>
          <Text>{kv('Updated', vm.metadata.updated, 13)}</Text>
        </CardLine>
      </CardSection>

      {/* Description */}
      <CardSection title="Description" width={w}>
        <CardLine width={w} lines={wrapTextWithIndent(vm.description, innerWidth)} />
      </CardSection>

      {/* Tags */}
      {vm.tags !== '—' && (
        <CardSection title="Tags" width={w}>
          <CardLine width={w}>
            <Text>{vm.tags}</Text>
          </CardLine>
        </CardSection>
      )}

      {/* Modality */}
      <CardSection title="Modality" width={w}>
        <CardLine width={w}>
          <Text>{kv('Input', vm.modalityInput, 8)}</Text>
        </CardLine>
        <CardLine width={w}>
          <Text>{kv('Output', vm.modalityOutput, 8)}</Text>
        </CardLine>
      </CardSection>

      {/* Features */}
      <CardSection title="Features" width={w}>
        <CardLine width={w} lines={wrapTextWithIndent(vm.features, innerWidth)} />
      </CardSection>

      {/* Pricing */}
      <CardSection title="Pricing" width={w}>
        <PricingContent
          pricingType={vm.pricingType}
          pricingLines={vm.pricingLines}
          builtInTools={vm.builtInTools}
          width={w}
        />
      </CardSection>

      {/* Context (LLM only) */}
      {vm.context && (
        <CardSection title="Context" width={w}>
          <CardLine width={w}>
            <Text>{kv('Window', vm.context.window, 12)}</Text>
          </CardLine>
          <CardLine width={w}>
            <Text>{kv('Max Input', vm.context.maxInput, 12)}</Text>
          </CardLine>
          <CardLine width={w}>
            <Text>{kv('Max Output', vm.context.maxOutput, 12)}</Text>
          </CardLine>
        </CardSection>
      )}

      {/* Rate Limits */}
      <CardSection title="Rate Limits" width={w}>
        <CardLine width={w}>
          <Text>{vm.rateLimits}</Text>
        </CardLine>
      </CardSection>

      {/* Free Tier */}
      {vm.freeTier && (
        <CardSection title="Free Tier" width={w}>
          <FreeTierContent vm={vm} width={w} />
        </CardSection>
      )}
    </Card>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FreeTierContent({ vm, width }: { vm: ModelDetailViewModel; width: number }) {
  const ft = vm.freeTier!;

  if (ft.mode === 'only') {
    return (
      <CardLine width={width}>
        <Text>
          {theme.success('Free')} {theme.muted('(Early Access — no paid option)')}
        </Text>
      </CardLine>
    );
  }

  if (
    ft.mode === 'standard' &&
    ft.total &&
    ft.remaining !== undefined &&
    ft.remainingPct !== undefined
  ) {
    const bar = progressBar(ft.remainingPct);
    const pctStr = ft.statusLabel ?? `${ft.remainingPct.toFixed(1)}%`;
    return (
      <>
        <CardLine width={width}>
          <Text>{kv('Total', ft.total, 12)}</Text>
        </CardLine>
        <CardLine width={width}>
          <Text>{kv('Remaining', ft.remaining, 12) + '  ' + bar + '  ' + pctStr}</Text>
        </CardLine>
        {ft.resetDate && (
          <CardLine width={width}>
            <Text>{kv('Resets', ft.resetDate, 12)}</Text>
          </CardLine>
        )}
      </>
    );
  }

  // mode=standard but no quota data yet
  return (
    <CardLine width={width}>
      <Text>{theme.muted('Quota data unavailable')}</Text>
    </CardLine>
  );
}

function PricingContent({
  pricingType,
  pricingLines,
  builtInTools,
  width,
}: {
  pricingType: ModelDetailViewModel['pricingType'];
  pricingLines: PricingLineViewModel[];
  builtInTools: BuiltInToolViewModel[];
  width: number;
}) {
  if (pricingType === 'llm') {
    return <LlmPricing pricingLines={pricingLines} builtInTools={builtInTools} width={width} />;
  }
  if (pricingType === 'video') {
    return <VideoPricing pricingLines={pricingLines} width={width} />;
  }
  // image, tts, asr, embedding — single price line
  const first = pricingLines[0];
  if (!first) return null;
  const label = first.cells.label ? first.cells.label + '  ' : '';
  const price = first.cells.price ?? '';
  return (
    <CardLine width={width}>
      <Text>
        {theme.muted(label)}
        {theme.accent(price)}
      </Text>
    </CardLine>
  );
}

function LlmPricing({
  pricingLines,
  builtInTools,
  width,
}: {
  pricingLines: PricingLineViewModel[];
  builtInTools: BuiltInToolViewModel[];
  width: number;
}) {
  const innerWidth = Math.max(0, width - 6);
  const hasCache = pricingLines.some((l) => l.cells.cacheCreation != null);
  const allFree = pricingLines.every(
    (l) => l.cells.input.includes('0.00') && l.cells.output.includes('0.00'),
  );

  if (allFree && pricingLines.length === 1) {
    return (
      <CardLine width={width}>
        <Text bold>
          {theme.success('Free')} {theme.muted('(Early Access)')}
        </Text>
      </CardLine>
    );
  }

  // Column widths (content only — separators ` │ ` are added between)
  // Use visibleWidth so CJK labels (e.g. "标准版") are measured correctly
  const COL_TIER = maxVisibleWidth(pricingLines.map((l) => l.cells.label), 4);
  const COL_IN = maxVisibleWidth(pricingLines.map((l) => l.cells.input), 5);
  const COL_OUT = maxVisibleWidth(pricingLines.map((l) => l.cells.output), 6);
  const COL_CC = hasCache
    ? maxVisibleWidth(pricingLines.map((l) => l.cells.cacheCreation ?? '—'), 11)
    : 0;
  const COL_CR = hasCache
    ? maxVisibleWidth(pricingLines.map((l) => l.cells.cacheRead ?? '—'), 10)
    : 0;
  const priceCols = hasCache
    ? [COL_TIER, COL_IN, COL_OUT, COL_CC, COL_CR]
    : [COL_TIER, COL_IN, COL_OUT];

  // Header: plain ` │ ` separators (bg color covers them all)
  const hParts = hasCache
    ? [
        padEndVisible('Tier', COL_TIER),
        padEndVisible('Input', COL_IN),
        padEndVisible('Output', COL_OUT),
        padEndVisible('Cache Write', COL_CC),
        padEndVisible('Cache Read', COL_CR),
      ]
    : [padEndVisible('Tier', COL_TIER), padEndVisible('Input', COL_IN), padEndVisible('Output', COL_OUT)];
  const headerStr = hParts.join(' │ ').padEnd(innerWidth);

  // Row builder: COL_DIV (dark purple ` │ `) between cells
  function buildRow(line: PricingLineViewModel): string {
    const parts = hasCache
      ? [
          padEndVisible(line.cells.label, COL_TIER),
          padColored(theme.accent(line.cells.input), COL_IN),
          padColored(theme.accent(line.cells.output), COL_OUT),
          padColored(theme.accent(line.cells.cacheCreation ?? '—'), COL_CC),
          theme.accent(line.cells.cacheRead ?? '—'),
        ]
      : [
          padEndVisible(line.cells.label, COL_TIER),
          padColored(theme.accent(line.cells.input), COL_IN),
          theme.accent(line.cells.output),
        ];
    return parts.join(COL_DIV);
  }

  const nodes: React.ReactNode[] = [
    <CardLine key="price-hdr" width={width}>
      <Text bold color={theme.tableHeader.fg} backgroundColor={theme.tableHeader.bg}>
        {headerStr}
      </Text>
    </CardLine>,
    <CardLine key="price-sep" width={width}>
      <Text>{buildSep(priceCols, innerWidth)}</Text>
    </CardLine>,
    ...pricingLines.map((line, i) => (
      <CardLine key={`price-${i}`} width={width}>
        <Text>{buildRow(line)}</Text>
      </CardLine>
    )),
  ];

  // Built-in Tools
  if (builtInTools.length > 0) {
    const COL_TNAME = maxVisibleWidth(builtInTools.map((t) => t.name), 4);
    const COL_TPRICE = maxVisibleWidth(builtInTools.map((t) => t.price), 5);
    const COL_TAPI = maxVisibleWidth(builtInTools.map((t) => t.api), 3);

    const toolHeaderStr = [
      padEndVisible('Name', COL_TNAME),
      padEndVisible('Price', COL_TPRICE),
      padEndVisible('API', COL_TAPI),
    ]
      .join(' │ ')
      .padEnd(innerWidth);

    nodes.push(
      <CardLine key="tools-spacer" width={width}>
        <Text>{''}</Text>
      </CardLine>,
      <CardLine key="tools-label" width={width}>
        <Text bold color={colors.brand}>
          {padEndVisible('Built-in Tools', innerWidth)}
        </Text>
      </CardLine>,
      <CardLine key="tools-hdr" width={width}>
        <Text bold color={theme.tableHeader.fg} backgroundColor={theme.tableHeader.bg}>
          {toolHeaderStr}
        </Text>
      </CardLine>,
      <CardLine key="tools-sep" width={width}>
        <Text>{buildSep([COL_TNAME, COL_TPRICE, COL_TAPI], innerWidth)}</Text>
      </CardLine>,
    );

    builtInTools.forEach((tool) => {
      const priceStr = tool.price === 'Free' ? theme.success(tool.price) : theme.accent(tool.price);
      const parts = [
        padEndVisible(tool.name, COL_TNAME),
        padColored(priceStr, COL_TPRICE),
        theme.muted(tool.api),
      ];
      nodes.push(
        <CardLine key={`tool-${tool.name}`} width={width}>
          <Text>{parts.join(COL_DIV)}</Text>
        </CardLine>,
      );
    });
  }

  return <>{nodes}</>;
}

function VideoPricing({
  pricingLines,
  width,
}: {
  pricingLines: PricingLineViewModel[];
  width: number;
}) {
  const innerWidth = Math.max(0, width - 6);
  const COL_RES = maxVisibleWidth(pricingLines.map((l) => l.cells.resolution), 10);
  const COL_PRICE = maxVisibleWidth(pricingLines.map((l) => l.cells.price), 5);

  const headerStr = [padEndVisible('Resolution', COL_RES), padEndVisible('Price', COL_PRICE)]
    .join(' │ ')
    .padEnd(innerWidth);

  return (
    <>
      <CardLine width={width}>
        <Text bold color={theme.tableHeader.fg} backgroundColor={theme.tableHeader.bg}>
          {headerStr}
        </Text>
      </CardLine>
      <CardLine width={width}>
        <Text>{buildSep([COL_RES, COL_PRICE], innerWidth)}</Text>
      </CardLine>
      {pricingLines.map((line, i) => (
        <CardLine key={`price-${i}`} width={width}>
          <Text>
            {[padEndVisible(line.cells.resolution, COL_RES), theme.accent(line.cells.price)].join(COL_DIV)}
          </Text>
        </CardLine>
      ))}
    </>
  );
}

/**
 * Render model info via Ink.
 * Used by non-interactive mode as a drop-in replacement.
 */
export async function renderModelInfoInk(vm: ModelDetailViewModel): Promise<void> {
  await renderWithInk(<ModelInfoInk vm={vm} />);
}
