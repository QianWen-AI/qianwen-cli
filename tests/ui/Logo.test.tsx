import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Logo } from '../../src/ui/Logo.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('Logo component', () => {
  it('renders the box border characters', () => {
    const { lastFrame } = render(<Logo />);
    const out = lastFrame() ?? '';
    expect(out).toContain('╔');
    expect(out).toContain('╗');
    expect(out).toContain('╚');
    expect(out).toContain('╝');
  });

  it('contains brand name and tagline', () => {
    const { lastFrame } = render(<Logo />);
    const out = lastFrame() ?? '';
    expect(out).toContain(s.cliDisplayName);
    expect(out).toContain('Manage your AI from terminal');
  });

  it('includes a version string in v.. format', () => {
    const { lastFrame } = render(<Logo />);
    const out = lastFrame() ?? '';
    expect(out).toMatch(/v\d/);
  });
});
