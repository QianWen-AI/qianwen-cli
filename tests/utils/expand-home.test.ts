import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { expandHomePath } from '../../src/utils/expand-home.js';

const environment = vi.hoisted(() => ({ home: '', platform: 'linux' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => environment.home,
  platform: () => environment.platform,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
});

describe('expandHomePath', () => {
  it.each(['linux', 'darwin', 'win32'])(
    'expands only current-user home prefixes on %s',
    (platform) => {
      environment.platform = platform;
      environment.home = path.join(process.cwd(), 'fixture-home');
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });

      expect(expandHomePath('~')).toBe(environment.home);
      expect(expandHomePath('~/child')).toBe(path.join(environment.home, 'child'));
      expect(expandHomePath('~/child with spaces')).toBe(
        path.join(environment.home, 'child with spaces'),
      );
      expect(expandHomePath('~\\child')).toBe(
        platform === 'win32' ? path.join(environment.home, 'child') : '~\\child',
      );
      for (const input of [
        '',
        '~user',
        '~user/child',
        'foo~',
        './~/child',
        '$HOME/child',
        './child',
        '../child',
        '/absolute/child',
        'C:\\plugins\\child',
        '@qianwenai/plugin-demo@1.0.0',
      ]) {
        expect(expandHomePath(input)).toBe(input);
      }
    },
  );
});
