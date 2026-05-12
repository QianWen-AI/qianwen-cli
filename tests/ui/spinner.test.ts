import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSpinner, clearSpinnerLine } from '../../src/ui/spinner.js';

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
    const workFn = vi.fn().mockImplementation(
      () => new Promise(resolve => setTimeout(resolve, 500))
    );
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

    const workFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 500)),
    );
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
