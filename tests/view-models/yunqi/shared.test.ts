import { describe, it, expect } from 'vitest';
import { truncateCell } from '../../../src/view-models/yunqi/shared.js';
import { visibleWidth } from '../../../src/ui/textWrap.js';

const ELLIPSIS = '…';

describe('truncateCell', () => {
  it.each([undefined, ''])('renders a placeholder dash for a missing value (%s)', (value) => {
    expect(truncateCell(value, 10)).toBe('-');
  });

  it('returns the value unchanged while the display width stays within budget', () => {
    expect(truncateCell('Yunqi Conference', 20)).toBe('Yunqi Conference');
    expect(truncateCell('AI Native', 20)).toBe('AI Native');
  });

  it('does not truncate when the width equals the budget exactly', () => {
    expect(truncateCell('1234567890', 10)).toBe('1234567890');
  });

  it('truncates with an ellipsis once over budget and keeps the display width inside it', () => {
    const out = truncateCell('A'.repeat(200), 20);
    expect(visibleWidth(out)).toBeLessThanOrEqual(20);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
  });

  it('counts CJK full-width characters as two columns instead of by character count', () => {
    const out = truncateCell('云'.repeat(60), 10);
    expect(visibleWidth(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    // truncating 60 full-width characters by count would span 120 columns, far over budget
    expect(visibleWidth(out)).toBeLessThan(60);
  });

  it('collapses newlines so they cannot blow out a table row', () => {
    expect(truncateCell('a\r\nb', 20)).toBe('a b');
    expect(truncateCell('first paragraph\nsecond paragraph', 40)).toBe(
      'first paragraph second paragraph',
    );
  });

  it('compresses a whole paragraph into the budget', () => {
    const paragraph =
      'AI is redefining the boundaries of customer service. Business iteration outpaces headcount ' +
      'growth, and the traditional hire-more path has hit a ceiling. This forum focuses on ' +
      'redesigning customer service around AI, and lays out the real adoption path of an AI Native ' +
      'transformation through three flywheels.';
    const out = truncateCell(paragraph, 32);
    expect(visibleWidth(out)).toBeLessThanOrEqual(32);
    expect(visibleWidth(paragraph)).toBeGreaterThan(100);
  });
});
