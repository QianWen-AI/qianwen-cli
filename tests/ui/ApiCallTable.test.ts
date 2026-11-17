import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { clearRenderedFrames, lastRenderedFrame } from '../helpers/ink-render-mock.js';
import { buildApiCallViewModel } from '../../src/view-models/api-call.js';
import { visibleWidth } from '../../src/ui/textWrap.js';

vi.mock('../../src/ui/render.js', async (original) => {
  const { renderInkForTest } = await import('../helpers/ink-render-mock.js');
  return {
    ...(await original<typeof import('../../src/ui/render.js')>()),
    renderWithInk: renderInkForTest,
  };
});

import { renderApiCallInk } from '../../src/ui/ApiCallTable.js';

const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
const originalRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');

beforeEach(() => {
  clearRenderedFrames();
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 8 });
});

afterEach(() => {
  for (const [name, descriptor] of [
    ['columns', originalColumns],
    ['rows', originalRows],
  ] as const) {
    if (descriptor) Object.defineProperty(process.stdout, name, descriptor);
    else Reflect.deleteProperty(process.stdout, name);
  }
  clearRenderedFrames();
});

describe('ApiCallTable terminal width and complete data', () => {
  it.each([20, 40, 80])(
    'wraps long CJK fields and nested JSON within %i columns without truncation or a row cap',
    async (columns) => {
      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns });
      const field = `${'字段'.repeat(32)}尾`;
      const value = {
        entries: [{ text: `${'中文'.repeat(100)}终`, count: 0 }],
        active: false,
      };
      await renderApiCallInk(buildApiCallViewModel({ [field]: value }));
      const frame = stripAnsi(lastRenderedFrame() ?? '');
      expect(frame).toContain('FIELD');
      expect(frame).toContain('VALUE');
      for (const line of frame.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
      expect(frame).not.toContain('…');
      expect(frame.match(/字/g)).toHaveLength(32);
      expect(frame.match(/段/g)).toHaveLength(32);
      expect(frame.match(/中/g)).toHaveLength(100);
      expect(frame.match(/文/g)).toHaveLength(100);
      const compact = frame.replace(/[\s│─┼┬┴┌┐└┘├┤]+/g, '');
      expect(frame.match(/尾/g)).toHaveLength(1);
      expect(frame.match(/终/g)).toHaveLength(1);
      expect(compact).toContain('"count":0');
      expect(compact).toContain('"active":false');
      expect(frame.split('\n').length).toBeGreaterThan(8);
    },
  );

  it('preserves internal spaces in a wrapped value', async () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
    const value = `alpha  beta  gamma ${'长文本'.repeat(80)}`;
    await renderApiCallInk(buildApiCallViewModel({ text: value }));
    const frame = stripAnsi(lastRenderedFrame() ?? '');
    expect(frame).toContain('alpha  beta  gamma');
    expect(frame.match(/长/g)).toHaveLength(80);
    for (const line of frame.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  it('retains all rows after long wrapped values rather than clipping to terminal height', async () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 24 });
    const data = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `row${index}`,
        `item-${index}-${'数据'.repeat(16)}-END${index}`,
      ]),
    );
    await renderApiCallInk(buildApiCallViewModel(data));
    const frame = stripAnsi(lastRenderedFrame() ?? '');
    for (const line of frame.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    expect(frame.match(/数/g)).toHaveLength(12 * 16);
    expect(frame.match(/据/g)).toHaveLength(12 * 16);
    expect(frame.replace(/[\s│─┼┬┴┌┐└┘├┤]+/g, '')).toContain('END11');
  });
});
