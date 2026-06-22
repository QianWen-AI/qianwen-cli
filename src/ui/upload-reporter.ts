import chalk from 'chalk';
import { theme, colors } from './theme.js';
import type { UploadProgress } from '../types/file-input.js';

const FRAMES = theme.symbols.spinnerFrames;
const INTERVAL_MS = 80;

const brand = chalk.hex(colors.brand);
const success = chalk.hex(colors.success);
const errorColor = chalk.hex(colors.error);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx++;
  }
  if (idx === 0) return `${size} ${units[idx]}`;
  return `${size.toFixed(1)} ${units[idx]}`;
}

export interface UploadReporterOptions {
  stream?: NodeJS.WritableStream;
  isTTY?: boolean;
  animate?: boolean;
}

/**
 * Build a per-file upload progress reporter that renders a spinner and
 * completion lines to a writable stream (defaults to `process.stderr`).
 * When the stream is non-TTY the spinner animation is suppressed but
 * one-line status entries are still emitted to keep CI logs readable.
 */
export function createUploadReporter(
  options: UploadReporterOptions = {},
): (progress: UploadProgress) => void {
  const stream = options.stream ?? process.stderr;
  const isTTY =
    options.isTTY ?? Boolean((stream as NodeJS.WriteStream & { isTTY?: boolean }).isTTY);
  const animate = options.animate ?? isTTY;

  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let currentLabel = '';

  const stopSpinner = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (animate) stream.write('\r\x1b[K');
  };

  const drawSpinner = () => {
    stream.write(`\r\x1b[K  ${brand(FRAMES[frame] ?? '')}  ${currentLabel}`);
  };

  const startSpinner = (label: string) => {
    stopSpinner();
    currentLabel = label;
    frame = 0;
    if (animate) {
      drawSpinner();
      timer = setInterval(() => {
        frame = (frame + 1) % FRAMES.length;
        drawSpinner();
      }, INTERVAL_MS);
    } else {
      stream.write(`${label}\n`);
    }
  };

  return (p: UploadProgress) => {
    if (p.phase === 'start') {
      const counter = p.total > 1 ? `[${p.index + 1}/${p.total}] ` : '';
      const label = `Uploading ${counter}${p.filename} (${formatBytes(p.size)})...`;
      startSpinner(label);
      return;
    }

    if (p.phase === 'done') {
      stopSpinner();
      const url = p.ossUrl ?? '';
      stream.write(`  ${success('✓')} ${p.filename} → ${url}\n`);
      return;
    }

    stopSpinner();
    const detail = p.error ? ` — ${p.error}` : '';
    stream.write(`  ${errorColor('✗')} ${p.filename}${detail}\n`);
  };
}
