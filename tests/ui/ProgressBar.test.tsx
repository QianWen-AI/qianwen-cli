import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ProgressBar } from '../../src/ui/ProgressBar.js';

// Strip ANSI escape codes so assertions stay readable and don't depend on
// chalk's color output. The visible width / character composition is what we
// actually want to lock down here.
function frame(el: React.ReactElement): string {
  const { lastFrame } = render(el);
  return stripAnsi(lastFrame() ?? '');
}

describe('ProgressBar', () => {
  it('renders 50% with half filled blocks at default width 20', () => {
    const out = frame(<ProgressBar percentage={50} mode="remaining" showLabel={false} />);
    // Default width is 20, so half = 10 filled + 10 empty
    expect(out).toContain('█'.repeat(10));
    expect(out).toContain('░'.repeat(10));
  });

  it('renders 0% as fully empty bar', () => {
    const out = frame(<ProgressBar percentage={0} mode="remaining" showLabel={false} />);
    expect(out).toContain('░'.repeat(20));
    // No filled blocks at all
    expect(out).not.toContain('█');
  });

  it('renders 100% as fully filled bar', () => {
    const out = frame(<ProgressBar percentage={100} mode="remaining" showLabel={false} />);
    expect(out).toContain('█'.repeat(20));
    // No empty blocks
    expect(out).not.toContain('░');
  });

  it('clamps negative percentage to 0% (defensive)', () => {
    // Caller bug-protection: a -10% input should not blow up the layout.
    const out = frame(<ProgressBar percentage={-10} mode="remaining" showLabel={false} />);
    expect(out).toContain('░'.repeat(20));
  });

  it('clamps percentages > 100 to 100% (defensive)', () => {
    const out = frame(<ProgressBar percentage={150} mode="remaining" showLabel={false} />);
    expect(out).toContain('█'.repeat(20));
  });

  it('honors custom width', () => {
    const out = frame(<ProgressBar percentage={50} mode="remaining" width={10} showLabel={false} />);
    // 10 wide × 50% = 5 + 5
    expect(out).toContain('█'.repeat(5));
    expect(out).toContain('░'.repeat(5));
  });

  it('renders label when showLabel=true and label is provided', () => {
    const out = frame(<ProgressBar percentage={85} mode="remaining" label="85% left" />);
    expect(out).toContain('85% left');
  });

  it('omits label when showLabel=false even if label provided', () => {
    const out = frame(<ProgressBar percentage={85} mode="remaining" label="85% left" showLabel={false} />);
    expect(out).not.toContain('85%');
  });

  describe('free-only mode', () => {
    it('renders the literal "Free (Early Access)" text instead of bar', () => {
      const out = frame(<ProgressBar percentage={0} mode="free-only" />);
      expect(out).toContain('Free (Early Access)');
      // No filled/empty blocks
      expect(out).not.toContain('█');
      expect(out).not.toContain('░');
    });

    it('appends label in free-only mode when provided', () => {
      const out = frame(<ProgressBar percentage={0} mode="free-only" label="no quota" />);
      expect(out).toContain('Free (Early Access)');
      expect(out).toContain('no quota');
    });
  });

  describe('used mode', () => {
    it('renders bar based on used percentage', () => {
      const out = frame(<ProgressBar percentage={20} mode="used" showLabel={false} />);
      // 20 wide × 20% = 4 filled
      expect(out).toContain('█'.repeat(4));
      expect(out).toContain('░'.repeat(16));
    });
  });
});
