import { describe, expect, it } from 'vitest';
import {
  backgroundQrRenderedColumns,
  encodeQrModules,
  qrRenderedColumns,
  toBackgroundQrRows,
  toCompactQrRows,
  type QrModules,
} from '../../src/utils/qr-code.js';

describe('encodeQrModules', () => {
  it('generates a stable square matrix with a four-module quiet zone', () => {
    const value = 'https://pay.test.qianwenai.com/checkout/%E5%8D%83%E9%97%AE';
    const first = encodeQrModules(value);
    const second = encodeQrModules(value);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(8);
    expect(first.every((row) => row.length === first.length)).toBe(true);
    expect(first.slice(0, 4).every((row) => row.every((module) => module === false))).toBe(true);
    expect(first.every((row) => row.slice(0, 4).every((module) => module === false))).toBe(true);
    expect(first.slice(-4).every((row) => row.every((module) => module === false))).toBe(true);
    expect(first.every((row) => row.slice(-4).every((module) => module === false))).toBe(true);

    const compact = encodeQrModules('https://pay.test.qianwenai.com/checkout/ui-test');
    expect(compact).toHaveLength(37);
    expect(toCompactQrRows(compact)).toHaveLength(19);
  });

  it('accepts UTF-8 payment content without confusing it with truncated ASCII', () => {
    const utf8 = encodeQrModules('https://pay.test.qianwenai.com/checkout?subject=\u5343\u95ee');
    const ascii = encodeQrModules('https://pay.test.qianwenai.com/checkout?subject=SW');
    expect(utf8).not.toEqual(ascii);
  });

  it('rejects empty content and content beyond the terminal QR limit', () => {
    expect(() => encodeQrModules('')).toThrow('must not be empty');
    expect(() => encodeQrModules('x'.repeat(1_000))).toThrow();
  });
});

describe('toCompactQrRows', () => {
  it('assigns upper modules to the foreground and lower modules to the background, merging adjacent cells with the same colors', () => {
    const modules: QrModules = [
      [true, true, false, true],
      [true, true, false, false],
      [false, false, true, true],
    ];

    expect(toCompactQrRows(modules)).toEqual([
      // Row pair 0/1: dark/dark, dark/dark, light/light, dark/light
      [
        { text: '\u2580\u2580', backgroundColor: 'black', color: 'black' },
        { text: '\u2580', backgroundColor: 'white', color: 'white' },
        { text: '\u2580', backgroundColor: 'white', color: 'black' },
      ],
      // Row 2 has no partner row, so every lower half falls back to light.
      [
        { text: '\u2580\u2580', backgroundColor: 'white', color: 'white' },
        { text: '\u2580\u2580', backgroundColor: 'white', color: 'black' },
      ],
    ]);
  });

  it('always sets foreground and background colors so glyph gaps cannot expose a contrasting color', () => {
    const modules = encodeQrModules('https://pay.test.qianwenai.com/checkout/seam');

    for (const row of toCompactQrRows(modules)) {
      for (const segment of row) {
        expect(segment.color).toBeDefined();
        expect(segment.text).toMatch(/^\u2580+$/u);
      }
    }
  });

  it('combines each pair of module rows into one terminal row with one character per column', () => {
    const modules = encodeQrModules('https://pay.test.qianwenai.com/checkout/ui-test');
    const rows = toCompactQrRows(modules);

    expect(rows).toHaveLength(Math.ceil(modules.length / 2));
    expect(qrRenderedColumns(modules)).toBe(modules[0].length);
    for (const row of rows) {
      const width = row.reduce((sum, segment) => sum + segment.text.length, 0);
      expect(width).toBe(qrRenderedColumns(modules));
    }
  });
});

describe('toBackgroundQrRows', () => {
  it('renders only background colors using two spaces per module and no block glyphs', () => {
    const modules: QrModules = [
      [true, false, false],
      [false, true, true],
    ];

    expect(toBackgroundQrRows(modules)).toEqual([
      [
        { text: '  ', backgroundColor: 'black' },
        { text: '    ', backgroundColor: 'white' },
      ],
      [
        { text: '  ', backgroundColor: 'white' },
        { text: '    ', backgroundColor: 'black' },
      ],
    ]);
  });

  it('uses one terminal row per module and twice the module count as the width', () => {
    const modules = encodeQrModules('https://pay.test.qianwenai.com/checkout/ui-test');
    const rows = toBackgroundQrRows(modules);

    expect(rows).toHaveLength(modules.length);
    expect(backgroundQrRenderedColumns(modules)).toBe(modules[0].length * 2);
    for (const row of rows) {
      const width = row.reduce((sum, segment) => sum + segment.text.length, 0);
      expect(width).toBe(backgroundQrRenderedColumns(modules));
      for (const segment of row) {
        expect(segment.color).toBeUndefined();
        expect(segment.text).toMatch(/^ +$/u);
      }
    }
  });
});

describe('rendered column reporting', () => {
  it('reports width by column count rather than row count', () => {
    // A deliberately non-square grid: row count must not stand in for width.
    const modules: QrModules = [
      [false, false, false],
      [false, false, false],
    ];

    expect(qrRenderedColumns(modules)).toBe(3);
    expect(backgroundQrRenderedColumns(modules)).toBe(6);
  });
});
