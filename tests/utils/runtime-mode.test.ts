import { describe, it, expect, beforeEach } from 'vitest';
import {
  setReplMode,
  isReplMode,
  loginCommand,
  formatCmd,
} from '../../src/utils/runtime-mode.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

// runtime-mode keeps a module-scoped flag. There's no public reset, so each
// test must be aware of order. We test fresh-state behaviour first, then flip
// to REPL once and assert all helpers reflect the flip.

describe('runtime-mode (one-shot defaults)', () => {
  it('isReplMode → false initially', () => {
    expect(isReplMode()).toBe(false);
  });

  it(`loginCommand → "${s.cliName} login" in one-shot mode`, () => {
    expect(loginCommand()).toBe(`${s.cliName} login`);
  });

  it(`formatCmd → prefixes "${s.cliName} " in one-shot mode`, () => {
    expect(formatCmd('auth logout')).toBe(`${s.cliName} auth logout`);
    expect(formatCmd('config get')).toBe(`${s.cliName} config get`);
  });
});

describe('runtime-mode (after setReplMode)', () => {
  beforeEach(() => {
    // No reset API exists — once flipped, the flag stays true. Tests within
    // this block run with REPL mode enabled, mirroring real REPL startup.
    setReplMode();
  });

  it('isReplMode → true after setReplMode()', () => {
    expect(isReplMode()).toBe(true);
  });

  it('loginCommand → bare "login" in REPL mode', () => {
    expect(loginCommand()).toBe('login');
  });

  it('formatCmd → returns command unchanged in REPL mode', () => {
    expect(formatCmd('auth logout')).toBe('auth logout');
    expect(formatCmd('config get api.endpoint')).toBe('config get api.endpoint');
  });
});
