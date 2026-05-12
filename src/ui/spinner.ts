import chalk from 'chalk';
import { theme, colors } from './theme.js';

// Braille dot frames — smooth 10-frame cycle (sourced from theme)
const FRAMES = theme.symbols.spinnerFrames;
const INTERVAL_MS = 80;

// Brand spinner — uses the section-title (saturated) hue for stronger
// visibility of small braille-dot characters during loading.
const spin = chalk.hex(colors.brand);

/** Track how many spinners are currently animating on stdout. */
let activeCount = 0;

/**
 * If a spinner is currently active, erase its line so the next stderr write
 * starts on a fresh line.  Safe to call unconditionally — a no-op when no
 * spinner is running.
 *
 * Call this before writing to stderr from anywhere that might execute while
 * a spinner is animating (addDiagnostic, handleError, etc.).
 */
export function clearSpinnerLine(): void {
  if (activeCount > 0) {
    process.stdout.write('\r\x1b[K');
  }
}

/**
 * Run `fn` while showing an animated spinner on stdout.
 * Automatically skips animation in non-TTY or JSON contexts.
 *
 * @param label  Text shown next to the spinner, e.g. "Fetching models"
 * @param fn     Async work to perform
 * @param format Optional resolved format — pass 'json' to suppress output
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  format?: string,
): Promise<T> {
  const silent = format === 'json' || !process.stdout.isTTY;

  if (silent) return fn();

  let frame = 0;
  const write = (text: string) => process.stdout.write(text);

  activeCount++;
  // Draw first frame immediately so there's no blank gap
  write(`\r  ${spin(FRAMES[frame])}  ${label}…`);

  const timer = setInterval(() => {
    frame = (frame + 1) % FRAMES.length;
    write(`\r  ${spin(FRAMES[frame])}  ${label}…`);
  }, INTERVAL_MS);

  try {
    const result = await fn();
    return result;
  } finally {
    clearInterval(timer);
    activeCount--;
    // Erase the spinner line completely
    write('\r\x1b[K');
  }
}
