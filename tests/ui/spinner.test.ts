import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withSpinner,
  clearSpinnerLine,
  pauseSpinner,
  resumeSpinner,
} from '../../src/ui/spinner.js';

describe('withSpinner', () => {
  let writeSpy: any;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    originalIsTTY = process.stdout.isTTY;
    // Simulate TTY using Object.defineProperty
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    // Restore original isTTY value
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it('shows spinner during async operation', async () => {
    vi.useFakeTimers();

    const workFn = vi.fn().mockResolvedValue('done');
    const promise = withSpinner('Loading', workFn);

    // Initial frame rendered
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('⠋'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Loading'));

    // Advance timers to trigger interval and resolve the work
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe('done');
    expect(workFn).toHaveBeenCalledOnce();
    // Line cleared at the end
    expect(writeSpy).toHaveBeenCalledWith('\r\x1b[K');
  });

  it('clears spinner even on error', async () => {
    vi.useFakeTimers();

    const workFn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(withSpinner('Loading', workFn)).rejects.toThrow('fail');

    // Line cleared even on error
    expect(writeSpy).toHaveBeenCalledWith('\r\x1b[K');
  });

  it('skips spinner in non-TTY mode', async () => {
    // Set isTTY to false for this test
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      writable: true,
      configurable: true,
    });

    const workFn = vi.fn().mockResolvedValue('done');
    const result = await withSpinner('Loading', workFn);

    expect(result).toBe('done');
    expect(workFn).toHaveBeenCalledOnce();
    // No write calls should happen in non-TTY mode
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('skips spinner when format is json', async () => {
    const workFn = vi.fn().mockResolvedValue({ data: 42 });
    const result = await withSpinner('Loading', workFn, 'json');

    expect(result).toEqual({ data: 42 });
    expect(workFn).toHaveBeenCalledOnce();
    // No write calls should happen in JSON mode
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('cycles through Braille frames', async () => {
    vi.useFakeTimers();

    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const workFn = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const promise = withSpinner('Loading', workFn);

    // Initial frame: ⠋
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining(frames[0]));

    // Advance through several frames and verify each
    for (let i = 1; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(80);
      // Check the most recent write call contains the expected frame
      const allCalls = writeSpy.mock.calls;
      const lastCall = allCalls[allCalls.length - 1][0];
      expect(lastCall).toContain(frames[i % frames.length]);
    }

    // Resolve
    await vi.advanceTimersByTimeAsync(500);
    await promise;
  });
});

describe('clearSpinnerLine', () => {
  let writeSpy: any;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it('is a no-op when no spinner is active', () => {
    clearSpinnerLine();
    // Should NOT write anything to stdout
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('clears the spinner line when a spinner is active', async () => {
    vi.useFakeTimers();

    const workFn = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const promise = withSpinner('Loading', workFn);

    // Spinner has started — clearSpinnerLine should erase the line
    writeSpy.mockClear();
    clearSpinnerLine();
    expect(writeSpy).toHaveBeenCalledWith('\r\x1b[K');

    await vi.advanceTimersByTimeAsync(500);
    await promise;
  });

  it('becomes a no-op again after spinner completes', async () => {
    const workFn = vi.fn().mockResolvedValue('done');
    await withSpinner('Loading', workFn);

    writeSpy.mockClear();
    clearSpinnerLine();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('pauseSpinner / resumeSpinner', () => {
  let writeSpy: any;
  let originalIsTTY: boolean | undefined;
  let writes: string[];

  beforeEach(() => {
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((data: string) => writes.push(data) as unknown as boolean);
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it('pause stops the timer, erases the line and stays silent while an Ink view renders', async () => {
    vi.useFakeTimers();

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>((r) => {
      resolveWork = r;
    });
    const promise = withSpinner('Loading', () => work);

    await vi.advanceTimersByTimeAsync(160); // two interval ticks
    writes.length = 0;

    pauseSpinner();
    expect(writes).toEqual(['\r\x1b[K', '\n']);

    // Simulate an Ink confirmation page repaint: no spinner frame may be
    // interleaved with it while the timer is paused.
    const writesBeforeInk = writes.length;
    writes.push('[INK FRAME]');
    await vi.advanceTimersByTimeAsync(400);
    expect(writes.length).toBe(writesBeforeInk + 1);
    expect(writes).toEqual(['\r\x1b[K', '\n', '[INK FRAME]']);

    resumeSpinner();
    resolveWork('done');
    await promise;
  });

  it('resume breaks to a fresh line and restarts the animation', async () => {
    vi.useFakeTimers();

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>((r) => {
      resolveWork = r;
    });
    const promise = withSpinner('Loading', () => work);

    pauseSpinner();
    writes.length = 0;

    resumeSpinner();
    // Fresh-line break + an immediately redrawn frame
    expect(writes[0]).toBe('\n');
    expect(writes[1]).toContain('Loading');

    await vi.advanceTimersByTimeAsync(80);
    expect(writes[writes.length - 1]).toContain('\r');

    resolveWork('done');
    await promise;
    // Completion still erases the spinner line cleanly
    expect(writes[writes.length - 1]).toBe('\r\x1b[K');
  });

  it('clearSpinnerLine is a no-op while the spinner is paused', async () => {
    vi.useFakeTimers();

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>((r) => {
      resolveWork = r;
    });
    const promise = withSpinner('Loading', () => work);

    pauseSpinner();
    writes.length = 0;

    clearSpinnerLine();
    expect(writes).toEqual([]);

    resolveWork('done');
    await promise;
  });

  it('pause and resume are no-ops without an active spinner', () => {
    pauseSpinner();
    resumeSpinner();
    expect(writes).toEqual([]);
  });

  it('repeated pause/resume calls are idempotent within one spinner run', async () => {
    vi.useFakeTimers();

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>((r) => {
      resolveWork = r;
    });
    const promise = withSpinner('Loading', () => work);

    pauseSpinner();
    pauseSpinner(); // second pause is ignored
    const eraseCount = writes.filter((w) => w === '\r\x1b[K').length;
    expect(eraseCount).toBe(1);

    resumeSpinner();
    resumeSpinner(); // second resume is ignored
    const newlineCount = writes.filter((w) => w === '\n').length;
    expect(newlineCount).toBe(2); // one from pause, one from resume

    resolveWork('done');
    await promise;
  });
});
