import { describe, expect, it } from 'vitest';
import {
  comparePluginVersions,
  isCliVersionCompatible,
  isPrereleasePluginVersion,
  resolveHighestCompatiblePluginVersion,
  resolveMinimumCliVersion,
} from '../../src/plugins/compatibility.js';

describe('plugin CLI compatibility', () => {
  it('only opts into prereleases explicitly and keeps compatible build metadata versions', () => {
    const versions = {
      '1.0.0': {},
      '1.1.0+build-with-hyphen': {},
      '2.0.0-beta.1': {},
      '3.0.0': { qianwen: { minCliVersion: '99.0.0' } },
    };
    expect(isPrereleasePluginVersion('1.1.0+build-with-hyphen')).toBe(false);
    expect(resolveHighestCompatiblePluginVersion(versions, '1.11.0')).toBe(
      '1.1.0+build-with-hyphen',
    );
    expect(resolveHighestCompatiblePluginVersion(versions, '1.11.0', undefined, true)).toBe(
      '2.0.0-beta.1',
    );
    expect(
      resolveHighestCompatiblePluginVersion(versions, '1.11.0', '1.1.0+build-with-hyphen'),
    ).toBe('1.0.0');
  });

  it('uses SemVer prerelease precedence', () => {
    expect(comparePluginVersions('1.8.1-alpha.2', '1.8.1')).toBeLessThan(0);
    expect(comparePluginVersions('1.8.1', '1.8.1-alpha.2')).toBeGreaterThan(0);
    expect(comparePluginVersions('1.8.1+build.2', '1.8.1+build.1')).toBe(0);
    expect(comparePluginVersions('9007199254740993.0.0', '9007199254740992.0.0')).toBeGreaterThan(
      0,
    );
  });

  it('accepts an equal minimum and rejects a higher minimum', () => {
    expect(isCliVersionCompatible('1.8.1', '1.8.1')).toBe(true);
    expect(isCliVersionCompatible('1.8.0', '1.8.1')).toBe(false);
  });

  it('prefers an explicit minimum and recognizes both CLI package names', () => {
    expect(
      resolveMinimumCliVersion({
        qianwen: { minCliVersion: '2.0.0' },
        engines: { '@qianwenai/qianwen-cli': '>=1.0.0' },
      }),
    ).toBe('2.0.0');
    expect(resolveMinimumCliVersion({ engines: { '@qianwenai/qianwen-cli': '^1.8.1' } })).toBe('1.8.1');
    expect(
      resolveMinimumCliVersion({ peerDependencies: { '@qianwenai/qianwen-cli': '~1.7.0' } }),
    ).toBe('1.7.0');
  });

  it.each(['', ' ', '\t\n'])(
    'preserves explicit invalid minimum %j instead of falling back to engines',
    (minCliVersion) => {
      const minimum = resolveMinimumCliVersion({
        qianwen: { minCliVersion },
        engines: { '@qianwenai/qianwen-cli': '>=1.0.0' },
      });
      expect(minimum).toBe(minCliVersion);
      expect(isCliVersionCompatible('1.11.0', minimum)).toBe(false);
    },
  );

  it('treats only an omitted minimum as having no compatibility restriction', () => {
    expect(resolveMinimumCliVersion({ qianwen: {} })).toBeUndefined();
    expect(isCliVersionCompatible('1.11.0', undefined)).toBe(true);
  });
});
