import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { StatusLine } from '../../src/ui/StatusLine.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('StatusLine component', () => {
  it('renders pass status with label and detail', () => {
    const { lastFrame } = render(
      <StatusLine status="pass" label="auth" detail="Authenticated as foo" />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('auth');
    expect(out).toContain('Authenticated as foo');
  });

  it('renders fail status with action hint', () => {
    const { lastFrame } = render(
      <StatusLine
        status="fail"
        label="token"
        detail="Token expired"
        action={`Run: ${s.cliName} auth login`}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Token expired');
    expect(out).toContain(`Run: ${s.cliName} auth login`);
  });

  it('omits action when not provided', () => {
    const { lastFrame } = render(
      <StatusLine status="warn" label="cli_version" detail="v1.0.0 (1.1.0 available)" />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('v1.0.0 (1.1.0 available)');
    // No "Run:" hint should be present
    expect(out).not.toContain('Run:');
  });

  it('renders distinct symbols for each of the four status levels', () => {
    // Use stripAnsi so we compare visible characters (the symbol). Each status
    // must produce a *different* visible frame — proving the symbol mapping
    // really branches per status, not just renders a generic placeholder.
    const frames = (['pass', 'warn', 'info', 'fail'] as const).map((status) => {
      const { lastFrame } = render(<StatusLine status={status} label="x" detail="y" />);
      return stripAnsi(lastFrame() ?? '');
    });
    const uniqueSet = new Set(frames);
    expect(uniqueSet.size).toBe(4);
  });

  it('renders distinguishable visible symbols for pass vs fail (✓ vs ✗ family)', () => {
    // ink-testing-library strips ANSI in non-TTY by default, so we assert on
    // the visible characters of the leading symbol slot, NOT on color escapes.
    const passOut = stripAnsi(render(<StatusLine status="pass" label="x" detail="y" />).lastFrame() ?? '');
    const failOut = stripAnsi(render(<StatusLine status="fail" label="x" detail="y" />).lastFrame() ?? '');
    // Both must contain the label/detail
    expect(passOut).toContain('x');
    expect(failOut).toContain('x');
    // Leading symbol portion (before label 'x') must differ between pass and fail.
    // Slice off the prefix up to where 'x' starts; the chars BEFORE that point
    // include leading padding + the status symbol.
    const passSym = passOut.slice(0, passOut.indexOf('x'));
    const failSym = failOut.slice(0, failOut.indexOf('x'));
    expect(passSym).not.toBe(failSym);
    // Sanity: pass symbol commonly contains '✓' / '√' / 'PASS'-like marker
    // Use a loose check — at minimum a non-space, non-'x' visible glyph exists
    expect(passSym.trim().length).toBeGreaterThan(0);
    expect(failSym.trim().length).toBeGreaterThan(0);
  });

  it('action hint appears with visible separation from detail', () => {
    const withAction = stripAnsi(render(
      <StatusLine status="fail" label="t" detail="d" action="Run: foo" />,
    ).lastFrame() ?? '');
    const withoutAction = stripAnsi(render(
      <StatusLine status="fail" label="t" detail="d" />,
    ).lastFrame() ?? '');
    // The action variant must contain 'Run: foo' (which the no-action variant lacks)
    expect(withAction).toContain('Run: foo');
    expect(withoutAction).not.toContain('Run: foo');
    // 'Run: foo' must appear AFTER the detail 'd' (action is a trailing hint)
    expect(withAction.indexOf('Run: foo')).toBeGreaterThan(withAction.indexOf('d'));
  });
});
