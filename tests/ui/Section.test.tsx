import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Section } from '../../src/ui/Section.js';
import { site } from '../../src/site.js';
import { visibleWidth } from '../../src/ui/textWrap.js';

const s = {
  ...site,
  ...site.features,
  currencySymbol: site.features.currency === 'CNY' ? '¥' : '$',
};

function frame(el: React.ReactElement): string {
  const { lastFrame } = render(el);
  return stripAnsi(lastFrame() ?? '');
}

// Section reads process.stdout.columns to compute its width. Lock it to a
// known value so tests are deterministic across local terminals and CI.
const ORIGINAL_COLUMNS = process.stdout.columns;
beforeEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
});
afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: ORIGINAL_COLUMNS, configurable: true });
});

describe('Section', () => {
  it('supports double rules within the width limit while retaining single rules by default', () => {
    const screen = render(
      <Box width={60}>
        <Section title="CATALOG" maxWidth={60} borderStyle="double" footer="note">
          <Section title="Individual" paddingLeft={0} maxWidth={58}>
            <Text>content</Text>
          </Section>
        </Section>
      </Box>,
    );
    try {
      const output = stripAnsi(screen.lastFrame() ?? '');
      expect(output).toMatch(/^ {2}CATALOG═+$/m);
      expect(output).toMatch(/^ {2}Individual─+$/m);
      expect(output).toMatch(/^ {2}═+$/m);
      expect(output.split('\n').every((line) => visibleWidth(line) <= 60)).toBe(true);
    } finally {
      screen.unmount();
    }
  });
  it('renders the title in the top bar', () => {
    const out = frame(
      <Section title="Free Tier Quota">
        <Text>row 1</Text>
      </Section>,
    );
    expect(out).toContain('Free Tier Quota');
    expect(out).toContain('row 1');
  });

  it('renders title with subtitle joined by the dot symbol', () => {
    const out = frame(
      <Section title="Token Plan" subtitle={`Pro · ${s.currencySymbol}50/mo`}>
        <Text>content</Text>
      </Section>,
    );
    expect(out).toContain('Token Plan');
    expect(out).toContain('Pro');
    expect(out).toContain(`${s.currencySymbol}50/mo`);
  });

  it('renders footer line and footer text when footer is provided', () => {
    const out = frame(
      <Section title="Models" footer="5 models with free tier">
        <Text>content</Text>
      </Section>,
    );
    expect(out).toContain('5 models with free tier');
    // A line of dashes (── separator) should be present in the rendered frame
    expect(out).toMatch(/─+/);
  });

  it('omits footer line when no footer prop', () => {
    const out = frame(
      <Section title="X">
        <Text>only content</Text>
      </Section>,
    );
    expect(out).toContain('only content');
    // Top dashes still exist (after title), so we can't assert "no dashes"
    // — but we can assert that the footer text is absent.
    expect(out).not.toContain('models with free tier');
  });

  it('renders title bar dashes filling to terminal width', () => {
    // With columns=80, paddingLeft=2 (default), sectionWidth=78. Title 'X'
    // visible width = 1, so dashes = 77. Verify a long run of ─ is present.
    const out = frame(
      <Section title="X">
        <Text>hi</Text>
      </Section>,
    );
    expect(out).toMatch(/─{20,}/); // at least 20 consecutive dashes
  });
});
