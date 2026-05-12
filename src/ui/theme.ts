import chalk from 'chalk';
import { site } from '../site.js';

const t = site.uiTheme;

/** Raw color hex values for Ink <Text color={}> props */
export const colors = {
  brand: t.sectionTitle, // Section / Card titles (saturated variant)
  border: t.border,      // Section dividers, Card frames
  muted: t.muted,
  ghost: '#9CA3AF',      // gray-400 — REPL ghost/suggestion text (site-neutral)
  headerBg: t.tableHeader.bg,
  headerFg: t.tableHeader.fg,
} as const;

export const theme = {
  // Brand (chalk body text, REPL prompt, spinners)
  brand: chalk.hex(t.brand),

  // Semantic colors
  success: chalk.hex(t.success),
  error: chalk.hex(t.error),
  warning: chalk.hex(t.warning),
  info: chalk.hex(t.info),
  data: chalk.hex(t.data),

  // Text hierarchy
  label: chalk.hex('#9CA3AF'), // gray-400
  muted: chalk.hex(t.muted),
  accent: chalk.hex(t.accent),
  highlight: chalk.white.bold,
  border: chalk.hex(t.border),

  // Standard utilities
  dim: chalk.dim,
  bold: chalk.bold,

  // Table header: explicit bg+fg so both dark and light terminals get the same look
  tableHeader: {
    bg: t.tableHeader.bg,
    fg: t.tableHeader.fg,
  },

  // Status symbols
  symbols: {
    pass: '✓',
    fail: '✗',
    warn: '⚠',
    info: 'ℹ',
    arrow: '▸',
    dash: '─',
    dot: '·',
    spinnerFrames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  },

  // Progress bar characters
  bar: {
    filled: '█',
    empty: '░',
  },

  // Modality type colors — one fixed color per type, high-saturation, non-overlapping
  // NOTE: Currently unused in Ink components; reserved for future modality-aware rendering.
  modalityColors: {
    text: chalk.hex('#C4B5FD'),      // violet-300  — on-brand light purple
    image: chalk.hex('#FBB040'),     // amber-400   — warm, visual
    video: chalk.hex('#F472B6'),     // pink-400    — dynamic / motion
    audio: chalk.hex('#34D399'),     // emerald-400 — sound / wave
    embedding: chalk.hex('#60A5FA'), // blue-400    — vector / data
  } as Record<string, (text: string) => string>,
};

/**
 * Build a mini progress bar string.
 * @param pct       Remaining percentage (0–100)
 * @param barWidth  Number of block characters
 * @param colorFn   Override fill color (defaults to 4-stage dynamic color)
 * @param showPct   Append "99.7%" after the bar blocks
 */
// Interpolate between two hex colors, returning a hex string at position t (0–1)
function lerpColor(from: string, to: string, t: number): string {
  const parse = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(r1 + (r2 - r1) * t)}${hex(g1 + (g2 - g1) * t)}${hex(b1 + (b2 - b1) * t)}`;
}

// Progress bar gradient: deep → light (per site palette)
const GRAD_FROM = t.progressGradient.from;
const GRAD_TO = t.progressGradient.to;

function gradientFilled(count: number): string {
  if (count === 0) return '';
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0.5 : i / (count - 1);
    return chalk.hex(lerpColor(GRAD_FROM, GRAD_TO, t))(theme.bar.filled);
  }).join('');
}

export function buildProgressBar(
  pct: number,
  barWidth = 10,
  colorFn?: (s: string) => string,
  showPct = false,
): string {
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  // Use gradient when colorFn is theme.data (the brand purple bar), plain color otherwise
  const filledStr =
    colorFn === theme.data
      ? gradientFilled(filled)
      : (colorFn ?? progressColor(pct, 'remaining'))(theme.bar.filled.repeat(filled));
  const bar = filledStr + theme.muted(theme.bar.empty.repeat(empty));
  return showPct ? `${bar} ${pct.toFixed(1)}%` : bar;
}

// Color functions for progress bars
export function progressColor(
  percentage: number,
  mode: 'remaining' | 'used',
): (text: string) => string {
  if (mode === 'remaining') {
    // Free Tier: color by remaining percentage (4 stages)
    if (percentage > 50) return chalk.hex('#22C55E'); // green-500  — plenty left
    if (percentage > 20) return chalk.hex('#84CC16'); // lime-400   — getting lower
    if (percentage > 10) return chalk.hex('#F59E0B'); // amber-500  — running low
    return chalk.hex('#EF4444'); // red-500    — nearly gone
  } else {
    // Used: color by used percentage (green=low usage, red=high usage)
    if (percentage < 50) return chalk.green;
    if (percentage <= 80) return chalk.yellow;
    return chalk.red;
  }
}
