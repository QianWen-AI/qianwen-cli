import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DocsViewer } from '../../src/ui/DocsViewer.js';
import { AltScreenContext } from '../../src/ui/render.js';
import type { DocContentViewModel } from '../../src/view-models/docs/index.js';

vi.mock('../../src/utils/open-browser.js', () => ({
  openBrowser: vi.fn(),
}));

const ORIGINAL_COLUMNS = process.stdout.columns;
const ORIGINAL_ROWS = process.stdout.rows;

beforeEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: ORIGINAL_COLUMNS, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: ORIGINAL_ROWS, configurable: true });
});

const MOCK_URL = 'https://mock-docs.test.qianwenai.com/developer-guides/getting-started';

function makeContentVm(overrides: Partial<DocContentViewModel> = {}): DocContentViewModel {
  return {
    url: MOCK_URL,
    resolvedMarkdownUrl: `${MOCK_URL}.md`,
    content: '# Getting Started\n\nWelcome to the docs.',
    renderedLines: ['[H1] Getting Started', '', 'Welcome to the docs.'],
    error: null,
    anchor: null,
    anchorLine: null,
    ...overrides,
  };
}

function docsViewerLineCount(altScreen: boolean, vm?: DocContentViewModel): number {
  const inst = render(
    <AltScreenContext.Provider value={altScreen}>
      <DocsViewer vm={vm ?? makeContentVm()} url={MOCK_URL} onBack={() => {}} onQuit={() => {}} />
    </AltScreenContext.Provider>,
  );
  const count = stripAnsi(inst.lastFrame() ?? '').split('\n').length;
  inst.unmount();
  return count;
}

describe('DocsViewer alt-screen scrollback safety', () => {
  // rows is forced to 40 in beforeEach; the default doc is short (a few lines).
  it('pads to full terminal height when NOT on the alt-screen', () => {
    // Off the alt-screen (e.g. ConHost) the full-height padding is retained so
    // the redraw clears residue as before.
    expect(docsViewerLineCount(false)).toBeGreaterThanOrEqual(38);
  });

  it('does NOT pad to full height on the alt-screen (avoids Ink clearTerminal / \\x1b[3J)', () => {
    // On the alt-screen the buffer switch already guarantees a clean exit;
    // padding would push Ink into its clearTerminal path, whose \x1b[3J wipes
    // the terminal scrollback on Terminal.app/iTerm2. So the output stays at
    // chrome + content height only, well below the 40-row terminal.
    expect(docsViewerLineCount(true)).toBeLessThan(20);
  });

  it('renders fewer rows on the alt-screen than off it for the same document', () => {
    const vm = makeContentVm();
    expect(docsViewerLineCount(false, vm)).toBeGreaterThan(docsViewerLineCount(true, vm));
  });

  it('keeps height below the terminal for long docs that fill the viewport', () => {
    // A document taller than the viewport. Off the alt-screen it reaches full
    // terminal height; on the alt-screen one content row is reserved so the
    // total height stays < rows, keeping Ink off its clearTerminal (\x1b[3J) path.
    const longVm = makeContentVm({
      renderedLines: Array.from({ length: 80 }, (_, i) => `paragraph line ${i + 1}`),
      content: 'x',
    });
    expect(docsViewerLineCount(true, longVm)).toBeLessThan(docsViewerLineCount(false, longVm));
  });
});
