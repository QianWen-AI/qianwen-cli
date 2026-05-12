import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';

/**
 * Test helper: renders an Ink element via ink-testing-library,
 * captures lastFrame, then unmounts immediately.
 *
 * Used to replace renderWithInk/renderInteractive in test mocks so that
 * local (non-exported) Ink components inside command files get actually
 * executed (not just stubbed) — driving coverage of their JSX/branches.
 */
export const renderedFrames: string[] = [];

export async function renderInkForTest(element: ReactElement): Promise<void> {
  const inst = render(element);
  // Allow at least one effect tick so useEffect / async loadPage fires
  await new Promise((r) => setImmediate(r));
  const frame = inst.lastFrame();
  if (frame) renderedFrames.push(frame);
  inst.unmount();
}

export function clearRenderedFrames(): void {
  renderedFrames.length = 0;
}

export function lastRenderedFrame(): string | undefined {
  return renderedFrames[renderedFrames.length - 1];
}
