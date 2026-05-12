import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Text } from 'ink';
import { Card, CardLine, Section as InCardSection } from '../../src/ui/Card.js';

// Companion to Card.test.ts (which tests the pure buildSectionTitleParts helper).
// This file uses ink-testing-library to render the actual JSX components and
// assert the visible character composition of the borders and content.

function frame(el: React.ReactElement): string {
  const { lastFrame } = render(el);
  return stripAnsi(lastFrame() ?? '');
}

describe('Card (rendered)', () => {
  it('renders top, title, content, empty, and bottom borders', () => {
    const out = frame(
      <Card title="My Card" width={40}>
        <CardLine width={40}>
          <Text>hello</Text>
        </CardLine>
      </Card>,
    );

    // Top corners
    expect(out).toContain('┌');
    expect(out).toContain('┐');
    // Bottom corners
    expect(out).toContain('└');
    expect(out).toContain('┘');
    // Side bars (│) appear on both content and empty lines
    expect(out).toContain('│');
    // Title and content visible
    expect(out).toContain('My Card');
    expect(out).toContain('hello');
  });

  it('clamps width below the safe minimum (10)', () => {
    // safeWidth = max(10, 4) = 10, so we still see borders + a tiny inner area.
    const out = frame(
      <Card title="x" width={4}>
        <CardLine width={4}>
          <Text>y</Text>
        </CardLine>
      </Card>,
    );
    expect(out).toContain('┌');
    expect(out).toContain('┘');
  });
});

describe('CardLine (rendered)', () => {
  it('renders single-line children wrapped in │ ... │', () => {
    const out = frame(
      <CardLine width={20}>
        <Text>hi</Text>
      </CardLine>,
    );
    // Should contain at least two │ characters (left + right border)
    expect((out.match(/│/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('hi');
  });

  it('renders multi-line content via the lines prop', () => {
    const out = frame(<CardLine width={20} lines={['line one', 'line two', 'line three']} />);
    expect(out).toContain('line one');
    expect(out).toContain('line two');
    expect(out).toContain('line three');
  });

  it('applies bold styling when boldLine is true (smoke check)', () => {
    // We can't easily detect bold from stripped output, but the render must succeed
    // and contain the lines.
    const out = frame(<CardLine width={20} lines={['bold me']} boldLine />);
    expect(out).toContain('bold me');
  });
});

describe('In-Card Section (rendered)', () => {
  it('renders the divider, padded title, and children', () => {
    const out = frame(
      <Card title="Outer" width={40}>
        <InCardSection title="Metadata" width={40}>
          <CardLine width={40}>
            <Text>row</Text>
          </CardLine>
        </InCardSection>
      </Card>,
    );

    // Section divider uses ├──┤
    expect(out).toContain('├');
    expect(out).toContain('┤');
    // Title and child content present
    expect(out).toContain('Metadata');
    expect(out).toContain('row');
  });
});
