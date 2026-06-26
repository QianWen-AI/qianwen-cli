/**
 * Regression tests for the Ink render error boundary used by render.tsx.
 *
 * A component that throws during render must be caught by InkErrorBoundary —
 * which reports the error to its `onError` callback and renders nothing —
 * instead of bubbling to Ink's own boundary, which prints the raw "recreate
 * this component tree / InternalApp" component-stack dump that the support
 * `reply` ticket view (one-shot) and `rate` picker crashed with.
 *
 * (renderWithInk / renderInteractive themselves drive the real process.stdout /
 * stdin and Ink lifecycle, which never completes under vitest, so the boundary
 * component is exercised directly here.)
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import stripAnsi from 'strip-ansi';
import { InkErrorBoundary } from '../../src/ui/render.js';

function Boom(): React.ReactElement {
  throw new Error('boom-from-render');
}

describe('InkErrorBoundary', () => {
  it('catches a render-time throw, reports it once, and renders nothing', () => {
    const onError = vi.fn();
    const { lastFrame } = render(
      <InkErrorBoundary onError={onError}>
        <Boom />
      </InkErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]![0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('boom-from-render');

    // No raw React/Ink boundary dump in the rendered frame.
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).not.toMatch(/recreate this component tree|not valid as a React child/i);
  });

  it('renders children unchanged when nothing throws', () => {
    const onError = vi.fn();
    const { lastFrame } = render(
      <InkErrorBoundary onError={onError}>
        <Text>healthy</Text>
      </InkErrorBoundary>,
    );
    expect(onError).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? '')).toContain('healthy');
  });
});
