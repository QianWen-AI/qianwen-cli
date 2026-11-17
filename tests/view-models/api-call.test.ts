import { describe, expect, it } from 'vitest';
import { buildApiCallViewModel } from '../../src/view-models/api-call.js';

describe('buildApiCallViewModel', () => {
  it('preserves own-field order and business literals without inferring status, amounts or dates', () => {
    const data = {
      Success: false,
      Amount: '001.230000000000',
      Date: '2026-10-19T00:00:00Z',
      Count: 0,
      Empty: '',
      Nullable: null,
      Nested: { items: [1, '中文'], valid: true },
    };
    expect(buildApiCallViewModel(data)).toEqual({
      rows: [
        { field: 'Success', value: 'false' },
        { field: 'Amount', value: '001.230000000000' },
        { field: 'Date', value: '2026-10-19T00:00:00Z' },
        { field: 'Count', value: '0' },
        { field: 'Empty', value: '' },
        { field: 'Nullable', value: 'null' },
        { field: 'Nested', value: JSON.stringify(data.Nested) },
      ],
    });
  });

  it('preserves [index] for every array item, including nested objects, arrays and empty values', () => {
    expect(buildApiCallViewModel([{ id: 1 }, ['x', false], null, '', 0])).toEqual({
      rows: [
        { field: '[0]', value: '{"id":1}' },
        { field: '[1]', value: '["x",false]' },
        { field: '[2]', value: 'null' },
        { field: '[3]', value: '' },
        { field: '[4]', value: '0' },
      ],
    });
  });

  it.each([
    { data: null, value: 'null' },
    { data: false, value: 'false' },
    { data: 0, value: '0' },
    { data: '原样中文', value: '原样中文' },
    { data: '', value: '' },
    { data: {}, value: '{}' },
    { data: [], value: '[]' },
  ])('preserves scalar or empty collection $data in the $ row', ({ data, value }) => {
    expect(buildApiCallViewModel(data)).toEqual({ rows: [{ field: '$', value }] });
  });

  it('omits inherited fields and preserves own __proto__ and constructor keys as business data', () => {
    const data = Object.create({ inherited: 'hidden' }) as Record<string, unknown>;
    Object.defineProperties(data, {
      ['__proto__']: { enumerable: true, value: { safe: true } },
      constructor: { enumerable: true, value: 'business' },
      own: { enumerable: true, value: 1 },
    });
    expect(buildApiCallViewModel(data)).toEqual({
      rows: [
        { field: '__proto__', value: '{"safe":true}' },
        { field: 'constructor', value: 'business' },
        { field: 'own', value: '1' },
      ],
    });
  });

  it('prevents fields and values from injecting ESC/OSC/CSI, NUL, BEL or carriage returns', () => {
    const esc = String.fromCharCode(27);
    const unsafe = `${esc}[31m颜色${esc}[0m${esc}]0;title\u0007中文\u0000\r`;
    const vm = buildApiCallViewModel({ [unsafe]: unsafe, nested: { text: unsafe } });
    for (const row of vm.rows) {
      for (const text of [row.field, row.value]) {
        for (const code of [0, 7, 13, 27]) expect(text).not.toContain(String.fromCharCode(code));
      }
    }
    expect(vm.rows[0]?.field).toContain('中文');
    expect(vm.rows[0]?.value).toContain('中文');
  });

  it('keeps projection pure without modifying frozen input or nested values', () => {
    const nested = Object.freeze({ list: Object.freeze(['中文', 1]) });
    const data = Object.freeze({ nested, Amount: '0001.00' });
    const before = JSON.stringify(data);
    const first = buildApiCallViewModel(data);
    expect(buildApiCallViewModel(data)).toEqual(first);
    expect(JSON.stringify(data)).toBe(before);
  });
});
