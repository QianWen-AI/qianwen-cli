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

// State of the single active spinner animation. The CLI never nests spinners,
// so one module-level slot is enough.
let currentLabel = '';
let currentFrame = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let paused = false;

function drawFrame(): void {
  process.stdout.write(`\r  ${spin(FRAMES[currentFrame])}  ${currentLabel}…`);
}

function startTimer(): void {
  timer = setInterval(() => {
    currentFrame = (currentFrame + 1) % FRAMES.length;
    drawFrame();
  }, INTERVAL_MS);
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * If a spinner is currently active, erase its line so the next stderr write
 * starts on a fresh line.  Safe to call unconditionally — a no-op when no
 * spinner is running.
 *
 * Call this before writing to stderr from anywhere that might execute while
 * a spinner is animating (addDiagnostic, handleError, etc.).
 */
export function clearSpinnerLine(): void {
  // Paused spinners have no frame on screen — nothing to erase.
  if (activeCount > 0 && !paused) {
    process.stdout.write('\r\x1b[K');
  }
}

/**
 * Pause the active spinner before an interactive Ink view (e.g. a
 * confirmation page) takes over stdout: stop the animation timer, erase the
 * frame line and break to a fresh line so the Ink render starts clean. While
 * paused, no bytes are written by the spinner.
 *
 * No-op when no spinner is running or it is already paused.
 */
export function pauseSpinner(): void {
  if (activeCount === 0 || paused) return;
  paused = true;
  stopTimer();
  process.stdout.write('\r\x1b[K');
  process.stdout.write('\n');
}

/**
 * Resume a spinner paused by {@link pauseSpinner}: move below whatever the
 * interactive view printed, redraw the frame and restart the animation timer.
 *
 * No-op when no spinner is running or it is not paused.
 */
export function resumeSpinner(): void {
  if (activeCount === 0 || !paused) return;
  paused = false;
  process.stdout.write('\n');
  drawFrame();
  startTimer();
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

  currentLabel = label;
  currentFrame = 0;
  paused = false;

  activeCount++;
  // Draw first frame immediately so there's no blank gap
  drawFrame();
  startTimer();

  try {
    const result = await fn();
    return result;
  } finally {
    stopTimer();
    activeCount--;
    // Erase the spinner line completely
    process.stdout.write('\r\x1b[K');
  }
}
