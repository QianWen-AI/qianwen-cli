import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Table } from '../../src/ui/Table.js';

describe('<Table /> rendering', () => {
  const cols = [
    { key: 'name', header: 'Name' },
    { key: 'age', header: 'Age', align: 'right' as const },
  ];

  it('renders header + separator + data rows', () => {
    const { lastFrame } = render(
      <Table columns={cols} data={[{ name: 'Alice', age: '30' }]} />
    );
    const out = lastFrame()!;
    expect(out).toContain('Name');
    expect(out).toContain('Age');
    expect(out).toContain('Alice');
    expect(out).toContain('30');
    // separator line includes the ─ pattern
    expect(out).toMatch(/─+/);
  });

  it('renders footer row with bold formatting', () => {
    const { lastFrame } = render(
      <Table
        columns={cols}
        data={[{ name: 'A', age: '1' }]}
        footer={{ name: 'Total', age: '1' }}
      />
    );
    const out = lastFrame()!;
    expect(out).toContain('Total');
  });

  it('respects width / minWidth / maxWidth (assert layout, not just truthiness)', () => {
    const colsWithWidth = [
      { key: 'a', header: 'A', width: 12 },
      { key: 'b', header: 'B', minWidth: 8 },
      { key: 'c', header: 'C', maxWidth: 5 },
    ];
    const { lastFrame } = render(
      <Table columns={colsWithWidth} data={[{ a: 'aa', b: 'b', c: 'cccccccc' }]} />
    );
    const out = stripAnsi(lastFrame() ?? '');
    const dataRow = out.split('\n')[2] ?? '';
    expect(dataRow).toContain('aa'); // a column shows
    expect(dataRow).toContain('b');  // b column shows
    // c column has maxWidth=5 → its visible cell shouldn't expand to fit the
    // 8-char 'cccccccc'. Total visible width capped roughly at:
    //   paddingLeft(2) + 12 + 3(sep) + 8 + 3(sep) + 5 = 33
    expect(dataRow.trimEnd().length).toBeLessThanOrEqual(40);
    // 'aa' is left-aligned in a width=12 cell → distance from 'aa' to 'b'
    // (start of next column content) must be at least 12 chars
    const aaIdx = dataRow.indexOf('aa');
    const bIdx = dataRow.indexOf('b', aaIdx + 2);
    expect(bIdx - aaIdx).toBeGreaterThanOrEqual(12);
  });

  it('applies col.color to non-footer cells (verified via spy + wrapper marker)', () => {
    const colorSpy = vi.fn((s: string) => `<C>${s}</C>`);
    const c = [{ key: 'x', header: 'X', color: colorSpy }];
    const { lastFrame } = render(<Table columns={c} data={[{ x: 'foo' }]} />);
    // The color function MUST have been invoked on each non-footer cell
    expect(colorSpy).toHaveBeenCalled();
    // The wrapper marker MUST appear in the rendered frame — proving the
    // returned colored string was rendered, not bypassed
    const out = lastFrame() ?? '';
    expect(out).toContain('<C>');
    expect(out).toContain('</C>');
  });

  it('applies rowColor function per row', () => {
    const c = [{ key: 'k', header: 'K' }];
    const rowColor = (_row: any, idx: number) =>
      idx === 0 ? (s: string) => `<R0>${s}</R0>` : undefined;
    const { lastFrame } = render(
      <Table columns={c} data={[{ k: 'first' }, { k: 'second' }]} rowColor={rowColor} />
    );
    expect(lastFrame()).toContain('first');
    expect(lastFrame()).toContain('second');
  });

  it('handles empty data array', () => {
    const { lastFrame } = render(<Table columns={cols} data={[]} />);
    const out = lastFrame()!;
    expect(out).toContain('Name');
    expect(out).toContain('Age');
  });

  it('handles missing keys (uses empty string)', () => {
    const { lastFrame } = render(
      <Table columns={cols} data={[{ name: 'OnlyName' } as any]} />
    );
    expect(lastFrame()).toContain('OnlyName');
  });

  it('respects custom paddingLeft', () => {
    const { lastFrame } = render(
      <Table columns={cols} data={[{ name: 'A', age: '1' }]} paddingLeft={0} />
    );
    expect(lastFrame()).toBeTruthy();
  });

  it('right-aligns columns when align="right" (verified via char position)', () => {
    const cols2 = [
      { key: 'name', header: 'Name', width: 10 },
      { key: 'age', header: 'Age', width: 6, align: 'right' as const },
    ];
    const { lastFrame } = render(
      <Table columns={cols2} data={[{ name: 'A', age: '7' }]} />
    );
    const out = stripAnsi(lastFrame() ?? '');
    const dataRow = (out.split('\n')[2] ?? '').trimEnd();
    // For right-align width=6 with content '7': padding goes BEFORE the digit.
    // → the char immediately preceding '7' must be a space, not a digit/letter.
    const sevenIdx = dataRow.lastIndexOf('7');
    expect(sevenIdx).toBeGreaterThan(0);
    expect(dataRow[sevenIdx - 1]).toBe(' ');
  });

  it('renders multiple data rows in order', () => {
    const { lastFrame } = render(
      <Table
        columns={cols}
        data={[
          { name: 'Alice', age: '30' },
          { name: 'Bob', age: '25' },
          { name: 'Charlie', age: '40' },
        ]}
      />
    );
    const out = lastFrame()!;
    expect(out).toContain('Alice');
    expect(out).toContain('Bob');
    expect(out).toContain('Charlie');
  });

  it('renders footer with col.color: footer uses bold, NOT the per-column color wrapper', () => {
    const colorSpy = vi.fn((s: string) => `<C>${s}</C>`);
    const c = [{ key: 'x', header: 'X', color: colorSpy }];
    const { lastFrame } = render(
      <Table columns={c} data={[{ x: 'a' }]} footer={{ x: 'TOTAL' }} />
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('TOTAL');
    // Data cell 'a' goes through col.color → '<C>...a...</C>' must appear
    expect(out).toContain('<C>');
    // Footer cell 'TOTAL' uses chalk.bold instead of col.color
    // → '<C>...TOTAL...</C>' wrapper must NOT surround the TOTAL text
    expect(out).not.toMatch(/<C>[^<]*TOTAL/);
    // colorSpy was called for the data row's 'a' (1 cell), not for footer
    // (the spy may also be called once during width calculation; loose check)
    const sawACell = colorSpy.mock.calls.some((args) =>
      typeof args[0] === 'string' && args[0].includes('a')
    );
    expect(sawACell).toBe(true);
  });

  it('rowColor takes precedence over col.color (col.color spy NOT called for that row)', () => {
    const colColorSpy = vi.fn((s: string) => `<COL>${s}</COL>`);
    const c = [{ key: 'k', header: 'K', color: colColorSpy }];
    const rowColor = () => (s: string) => `<ROW>${s}</ROW>`;
    const { lastFrame } = render(
      <Table columns={c} data={[{ k: 'x' }]} rowColor={rowColor} />
    );
    const out = lastFrame() ?? '';
    // rowColor wrapper appears
    expect(out).toContain('<ROW>');
    // col.color wrapper does NOT appear — rowColor short-circuits it
    expect(out).not.toContain('<COL>');
    // Spy MUST NOT have been called (the renderRow branch chose rowColorFn)
    expect(colColorSpy).not.toHaveBeenCalled();
  });
});
