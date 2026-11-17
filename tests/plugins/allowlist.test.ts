import { describe, it, expect } from 'vitest';
import { isOfficialPlugin } from '../../src/plugins/allowlist.js';

describe('isOfficialPlugin — exact scope matching for npm installs', () => {
  it('accepts packages within a trusted scope', () => {
    expect(isOfficialPlugin('@qianwenai/qianwen-plugin-demo')).toBe(true);
    expect(isOfficialPlugin('@qianwenai/plugin-demo')).toBe(true);
    expect(isOfficialPlugin('@qianwenai/a')).toBe(true);
  });

  it('rejects lookalike scopes with similar prefixes', () => {
    expect(isOfficialPlugin('@qianwenaix/pkg')).toBe(false);
    expect(isOfficialPlugin('@qianwenai-evil/pkg')).toBe(false);
  });

  it('rejects unscoped packages', () => {
    expect(isOfficialPlugin('plugin-demo')).toBe(false);
    expect(isOfficialPlugin('qianwen-plugin')).toBe(false);
  });

  it('rejects malformed scopes', () => {
    expect(isOfficialPlugin('@qianwenai')).toBe(false);
    expect(isOfficialPlugin('@QIANWENAI/pkg')).toBe(false);
    expect(isOfficialPlugin('')).toBe(false);
  });

  it('checks only the scope; the installer validates npm package name syntax', () => {
    // '@qianwenai/' passes the scope gate; the installer rejects it as an invalid
    // npm package name before anything is downloaded.
    expect(isOfficialPlugin('@qianwenai/')).toBe(true);
  });
});
