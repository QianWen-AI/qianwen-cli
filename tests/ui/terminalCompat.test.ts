import { afterEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { isConHost, resolveQrRenderMode } from '../../src/ui/terminalCompat.js';

/** Environment keys that participate in QR mode selection. */
const ENV_KEYS = [
  'WT_SESSION',
  'TERM_PROGRAM',
  'TERM',
  'TMUX',
  'VTE_VERSION',
  'KONSOLE_VERSION',
  'KITTY_WINDOW_ID',
  'QIANWEN_QR_STYLE',
] as const;

interface TerminalEnv {
  readonly platform?: NodeJS.Platform;
  readonly stdinTTY?: boolean;
  readonly stdoutTTY?: boolean;
  /** Highest palette size the stream reports; `false` reports no colour at all. */
  readonly colors?: false | 2 | 16;
  /** chalk's own decision, which is independent of `hasColors`. */
  readonly chalkLevel?: 0 | 1 | 2 | 3;
  readonly env?: Partial<Record<(typeof ENV_KEYS)[number], string>>;
}

const restores: (() => void)[] = [];

function override<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

/** Install a fully specified terminal environment for one assertion. */
function setTerminal({
  platform = 'darwin',
  stdinTTY = true,
  stdoutTTY = true,
  colors = 16,
  chalkLevel = 3,
  env = {},
}: TerminalEnv): void {
  override(process, 'platform', platform);
  override(process.stdin, 'isTTY', stdinTTY);
  override(process.stdout, 'isTTY', stdoutTTY);
  // Mirror Node's contract: hasColors(n) is true when n fits the palette.
  // The signature is overloaded (count and/or env), so narrow before comparing.
  const hasColors = vi.fn((countOrEnv?: number | object) => {
    const count = typeof countOrEnv === 'number' ? countOrEnv : 16;
    return colors !== false && count <= colors;
  }) as unknown as typeof process.stdout.hasColors;
  override(process.stdout, 'hasColors', hasColors);
  const previousLevel = chalk.level;
  chalk.level = chalkLevel;
  restores.push(() => {
    chalk.level = previousLevel;
  });
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      const previous = process.env[key];
      if (previous !== undefined) {
        Reflect.deleteProperty(process.env, key);
        restores.push(() => {
          process.env[key] = previous;
        });
      }
      continue;
    }
    const previous = process.env[key];
    process.env[key] = value;
    restores.push(() => {
      if (previous === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = previous;
    });
  }
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  vi.restoreAllMocks();
});

describe('isConHost', () => {
  it('matches only Windows hosts without WT_SESSION or TERM_PROGRAM', () => {
    setTerminal({ platform: 'win32' });
    expect(isConHost()).toBe(true);

    setTerminal({ platform: 'win32', env: { WT_SESSION: '1' } });
    expect(isConHost()).toBe(false);

    setTerminal({ platform: 'darwin' });
    expect(isConHost()).toBe(false);
  });
});

describe('resolveQrRenderMode', () => {
  it('disables QR rendering without a TTY', () => {
    setTerminal({ stdinTTY: false });
    expect(resolveQrRenderMode()).toBe('off');

    setTerminal({ stdoutTTY: false });
    expect(resolveQrRenderMode()).toBe('off');
  });

  it('disables QR rendering on two-color terminals because hasColors(2) is insufficient', () => {
    // getColorDepth() has a minimum of 1, so hasColors(2) is true for every TTY.
    // A monochrome terminal cannot distinguish CSI 40m from CSI 47m and renders one solid color.
    setTerminal({ colors: 2 });
    expect(process.stdout.hasColors?.(2)).toBe(true);
    expect(process.stdout.hasColors?.(16)).toBe(false);
    expect(resolveQrRenderMode()).toBe('off');
  });

  it('disables QR rendering when color is entirely unavailable', () => {
    setTerminal({ colors: false });
    expect(resolveQrRenderMode()).toBe('off');
  });

  it('disables QR rendering when chalk applies no color to avoid blank output', () => {
    // hasColors reads getColorDepth while chalk reads supports-color via FORCE_COLOR or NO_COLOR.
    // These checks may disagree, so the guard must describe the pipeline that actually colors output.
    setTerminal({ colors: 16, chalkLevel: 0 });
    expect(process.stdout.hasColors?.(16)).toBe(true);
    expect(resolveQrRenderMode()).toBe('off');
  });

  it('uses foreground blocks instead of disabling traditional ConHost and unknown Windows hosts', () => {
    // Windows Terminal drops the background SGR of blank cells on resize reflow,
    // so every Windows host paints explicitly coloured foreground blocks instead —
    // a code that survives the reflow rather than blanking out.
    setTerminal({ platform: 'win32' });
    expect(isConHost()).toBe(true);
    expect(resolveQrRenderMode()).toBe('foreground');

    setTerminal({ platform: 'win32', env: { TERM_PROGRAM: 'mystery-host' } });
    expect(resolveQrRenderMode()).toBe('foreground');
  });

  it('uses compact half-block mode only for terminals confirmed by TERM_PROGRAM', () => {
    for (const termProgram of ['Apple_Terminal', 'iTerm.app', 'WezTerm']) {
      setTerminal({ env: { TERM_PROGRAM: termProgram } });
      expect(resolveQrRenderMode()).toBe('compact');
    }
  });

  it('does not infer compact mode from inherited variables that cannot identify the current terminal', () => {
    // Other terminals do not clear VTE_VERSION, KONSOLE_VERSION, or KITTY_WINDOW_ID.
    // They only prove that the terminal appeared earlier in the process chain; a wrong guess breaks scanning.
    for (const env of [
      { VTE_VERSION: '6003' },
      { KONSOLE_VERSION: '220400' },
      { KITTY_WINDOW_ID: '1' },
    ]) {
      setTerminal({ env });
      expect(resolveQrRenderMode()).toBe('full');
    }
  });

  it('uses foreground blocks for Windows Terminal and WSL and background blocks elsewhere', () => {
    setTerminal({ platform: 'win32', env: { WT_SESSION: '1' } });
    expect(resolveQrRenderMode()).toBe('foreground');

    setTerminal({ platform: 'linux', env: { WT_SESSION: '1' } });
    expect(resolveQrRenderMode()).toBe('foreground');

    setTerminal({ env: { TMUX: '/tmp/tmux-501/default,1,0' } });
    expect(resolveQrRenderMode()).toBe('full');

    setTerminal({ env: { TERM: 'screen.xterm-256color' } });
    expect(resolveQrRenderMode()).toBe('full');

    setTerminal({});
    expect(resolveQrRenderMode()).toBe('full');
  });

  it('lets QIANWEN_QR_STYLE override auto-selection and falls back to auto for invalid values', () => {
    setTerminal({ env: { TERM_PROGRAM: 'Apple_Terminal', QIANWEN_QR_STYLE: 'full' } });
    expect(resolveQrRenderMode()).toBe('full');

    setTerminal({ env: { QIANWEN_QR_STYLE: 'compact' } });
    expect(resolveQrRenderMode()).toBe('compact');

    setTerminal({ env: { QIANWEN_QR_STYLE: 'off' } });
    expect(resolveQrRenderMode()).toBe('off');

    setTerminal({ env: { TERM_PROGRAM: 'Apple_Terminal', QIANWEN_QR_STYLE: 'nonsense' } });
    expect(resolveQrRenderMode()).toBe('compact');
  });

  it('does not let an override bypass TTY and color-capability guards', () => {
    setTerminal({ stdoutTTY: false, env: { QIANWEN_QR_STYLE: 'compact' } });
    expect(resolveQrRenderMode()).toBe('off');

    setTerminal({ colors: false, env: { QIANWEN_QR_STYLE: 'full' } });
    expect(resolveQrRenderMode()).toBe('off');

    setTerminal({ colors: 2, env: { QIANWEN_QR_STYLE: 'compact' } });
    expect(resolveQrRenderMode()).toBe('off');

    setTerminal({ chalkLevel: 0, env: { QIANWEN_QR_STYLE: 'compact' } });
    expect(resolveQrRenderMode()).toBe('off');

    setTerminal({ stdinTTY: false, env: { QIANWEN_QR_STYLE: 'full' } });
    expect(resolveQrRenderMode()).toBe('off');
  });

  it('still disables QR rendering on Windows without color support', () => {
    setTerminal({ platform: 'win32', colors: false });
    expect(resolveQrRenderMode()).toBe('off');
  });
});
