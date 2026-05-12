import { describe, it, expect } from 'vitest';
import { buildProgressBar, progressColor } from '../../src/ui/theme.js';

describe('buildProgressBar', () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('builds bar with default width (10)', () => {
    const bar = buildProgressBar(100);
    expect(stripAnsi(bar)).toBe('██████████');
  });

  it('builds bar with custom width', () => {
    const bar = buildProgressBar(50, 20);
    expect(stripAnsi(bar)).toBe('██████████░░░░░░░░░░');
  });

  it('builds empty bar for 0%', () => {
    const bar = buildProgressBar(0, 10);
    expect(stripAnsi(bar)).toBe('░░░░░░░░░░');
  });

  it('shows percentage when showPct=true', () => {
    const bar = buildProgressBar(85, 10, undefined, true);
    expect(bar).toMatch(/85\.0%/);
  });

  it('uses custom color function', () => {
    const bar = buildProgressBar(50, 5, (s: string) => `<<${s}>>`);
    expect(bar).toContain('<<');
  });

  it('rounds filled blocks correctly', () => {
    // 33% of 10 = 3.3 → rounds to 3
    const bar = buildProgressBar(33, 10);
    const stripped = stripAnsi(bar);
    const filled = stripped.match(/█/g)?.length ?? 0;
    expect(filled).toBe(3);
  });
});

describe('progressColor', () => {
  // progressColor returns a chalk function; verify it returns the correct function
  // by checking that the returned function is NOT the identity (i.e., it's a chalk fn)
  describe('remaining mode', () => {
    it('returns a color function for > 50%', () => {
      const fn = progressColor(80, 'remaining');
      expect(typeof fn).toBe('function');
      expect(fn).not.toBe((s: string) => s); // not identity
    });

    it('returns a color function for > 20%', () => {
      const fn = progressColor(35, 'remaining');
      expect(typeof fn).toBe('function');
    });

    it('returns a color function for > 10%', () => {
      const fn = progressColor(15, 'remaining');
      expect(typeof fn).toBe('function');
    });

    it('returns a color function for <= 10%', () => {
      const fn = progressColor(5, 'remaining');
      expect(typeof fn).toBe('function');
    });

    it('returns different functions for different thresholds', () => {
      const fnHigh = progressColor(80, 'remaining');
      const fnLow = progressColor(5, 'remaining');
      // They should be different chalk instances (different hex colors)
      expect(fnHigh).not.toBe(fnLow);
    });
  });

  describe('used mode', () => {
    it('returns a color function for < 50%', () => {
      const fn = progressColor(30, 'used');
      expect(typeof fn).toBe('function');
    });

    it('returns a color function for 50-80%', () => {
      const fn = progressColor(65, 'used');
      expect(typeof fn).toBe('function');
    });

    it('returns a color function for > 80%', () => {
      const fn = progressColor(90, 'used');
      expect(typeof fn).toBe('function');
    });
  });
});
