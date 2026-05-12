import { describe, it, expect } from 'vitest';
import { buildSectionTitleParts } from '../../src/ui/Card.js';
import { visibleWidth } from '../../src/ui/textWrap.js';

// Regression guard: ensures Section border alignment stays correct.
// Any change that breaks visible width will fail CI immediately.
describe('Card / buildSectionTitleParts', () => {
  it.each([20, 40, 60, 80, 120, 160])(
    'left + middle + right visible width equals card width = %i',
    (w) => {
      const { left, middle, right } = buildSectionTitleParts('Metadata', w);
      const total = visibleWidth(left) + visibleWidth(middle) + visibleWidth(right);
      expect(total).toBe(w);
    },
  );

  it('keeps left border segment at exactly 3 visible chars (│ + 2 spaces)', () => {
    // Hard-code 3 so anyone changing the spacing must consciously update the test.
    const { left } = buildSectionTitleParts('x', 80);
    expect(visibleWidth(left)).toBe(3);
  });

  it('keeps right border segment at exactly 3 visible chars (2 spaces + │)', () => {
    const { right } = buildSectionTitleParts('x', 80);
    expect(visibleWidth(right)).toBe(3);
  });

  it('clamps width below the safe minimum (10) to keep border segments intact', () => {
    // Section internally clamps width to >= 10. Border segments must always
    // remain 3 visible chars regardless of how small the caller's width is.
    const { left, right } = buildSectionTitleParts('x', 4);
    expect(visibleWidth(left)).toBe(3);
    expect(visibleWidth(right)).toBe(3);
  });

  it('pads short titles to fill the inner area (width - 6)', () => {
    const w = 80;
    const { middle } = buildSectionTitleParts('Tags', w);
    expect(visibleWidth(middle)).toBe(w - 6);
  });

  it('does not truncate titles that exceed the inner width — caller responsibility', () => {
    // padEndVisible is a no-op when the string already exceeds the target width; layout overflow is caller's concern.
    const longTitle = 'A'.repeat(100);
    const { middle } = buildSectionTitleParts(longTitle, 80);
    expect(middle.length).toBe(100);
  });

  // ── CJK border alignment ──────────────────────────────────────────────────

  it('CJK title: left + middle + right visible width equals card width', () => {
    const w = 80;
    const { left, middle, right } = buildSectionTitleParts('模型信息', w);
    const total = visibleWidth(left) + visibleWidth(middle) + visibleWidth(right);
    expect(total).toBe(w);
  });

  it('CJK title: middle segment fills the inner area (width - 6)', () => {
    const w = 80;
    const { middle } = buildSectionTitleParts('模型信息', w);
    expect(visibleWidth(middle)).toBe(w - 6);
  });

  it('CJK title: border segments remain 3 visible chars each', () => {
    const { left, right } = buildSectionTitleParts('标签', 80);
    expect(visibleWidth(left)).toBe(3);
    expect(visibleWidth(right)).toBe(3);
  });
});
