import { describe, expect, it } from 'vitest';
import { parsePluginApiPolicy } from '../../src/plugins/api-policy.js';

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { product: 'TestPortal', actions: ['ReadEntry'], auth: 'optional', ...overrides };
}

describe('plugin authentication and response policy schema', () => {
  it('accepts a plugin with no API policy', () => {
    expect(parsePluginApiPolicy([])).toEqual([]);
  });

  it.each([null, {}, 'optional', [null], [7]])('rejects malformed containers: %j', (input) => {
    expect(() => parsePluginApiPolicy(input)).toThrow();
  });

  it.each([
    { product: '' },
    { product: '   ' },
    { product: 7 },
    { actions: 'ReadEntry' },
    { actions: [] },
    { actions: [''] },
    { actions: [7] },
    { auth: 'none' },
    { auth: undefined },
    { response: 'unknown-envelope' },
    { response: null },
    { response: ['success-code-envelope'] },
    { endpoint: 'https://override.test.qianwenai.com' },
  ])('rejects malformed rules: %j', (changes) => {
    expect(() => parsePluginApiPolicy([rule(changes)])).toThrow();
  });

  it('keeps response adaptation independent of anonymous authentication', () => {
    const rules = [
      rule({ actions: ['PublicRaw'] }),
      rule({
        actions: ['PrivateEnvelope'],
        auth: 'required',
        response: 'success-code-envelope',
      }),
    ];
    expect(parsePluginApiPolicy(rules)).toEqual(rules);
  });

  it.each([
    { auth: 'required' },
    { response: 'success-code-envelope' },
    { auth: 'required', response: 'success-code-envelope' },
  ])('rejects conflicts independently of declaration order: %j', (changes) => {
    for (const rules of [
      [rule(), rule(changes)],
      [rule(changes), rule()],
    ]) {
      expect(() => parsePluginApiPolicy(rules)).toThrow();
    }
  });

  it('detects conflicts in overlapping action arrays', () => {
    expect(() =>
      parsePluginApiPolicy([
        rule({ actions: ['ReadEntry', 'ListEntries'] }),
        rule({ actions: ['ListEntries', 'OtherEntry'], auth: 'required' }),
      ]),
    ).toThrow();
  });

  it('deduplicates identical rules and keeps unrelated pairs', () => {
    expect(
      parsePluginApiPolicy([rule(), rule(), rule({ product: 'OtherPortal', auth: 'required' })]),
    ).toEqual([rule(), rule({ product: 'OtherPortal', auth: 'required' })]);
  });

  it('returns independent copies without changing product/action spelling', () => {
    const actions = ['ReadEntry'];
    const rules = parsePluginApiPolicy([rule({ actions })]);
    actions.push('ChangedAfterValidation');
    expect(rules).toEqual([rule()]);
  });
});
