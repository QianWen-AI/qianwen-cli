import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

// Mock the render entry points so renderSkillsSearchInk routing is observable
// without spawning a real Ink instance (renderInteractive needs a real TTY stdin).
const { renderWithInkSpy, renderInteractiveSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn().mockResolvedValue(undefined),
  renderInteractiveSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
  renderWithInkSync: renderWithInkSpy,
  renderInteractive: renderInteractiveSpy,
}));

import { SkillsSearchTable, renderSkillsSearchInk } from '../../src/ui/SkillsSearchTable.js';
import type { SkillsSearchViewModel } from '../../src/view-models/skills/index.js';

const vm: SkillsSearchViewModel = {
  query: 'pdf',
  totalCount: 2,
  isEmpty: false,
  rows: [
    {
      index: 1,
      slug: 'pdf-extractor',
      name: 'PDF Extractor',
      description: 'Extract text from PDFs',
      publisher: 'acme',
      currentVersion: '1.2.0',
      verified: true,
    },
    {
      index: 2,
      slug: 'pdf-merge',
      name: 'PDF Merge',
      description: 'Merge PDF files',
      publisher: 'beta',
      currentVersion: '—',
      verified: false,
    },
  ],
};

const emptyVm: SkillsSearchViewModel = {
  query: 'nothing',
  totalCount: 0,
  isEmpty: true,
  rows: [],
};

beforeEach(() => {
  renderWithInkSpy.mockClear();
  renderInteractiveSpy.mockClear();
});

describe('<SkillsSearchTable /> static rendering', () => {
  it('renders title, all rows and the install hint footer', () => {
    const { lastFrame } = render(<SkillsSearchTable vm={vm} />);
    const out = lastFrame()!;
    expect(out).toContain('Skills Search');
    expect(out).toContain('pdf-extractor');
    expect(out).toContain('pdf-merge');
    expect(out).toContain('2 skills');
    expect(out).toContain('skills install <slug>');
  });
});

describe('renderSkillsSearchInk routing', () => {
  it('mounts InteractiveTable as a single page carrying the full result set', async () => {
    await renderSkillsSearchInk(vm);
    expect(renderInteractiveSpy).toHaveBeenCalledTimes(1);
    expect(renderWithInkSpy).not.toHaveBeenCalled();
    const el = renderInteractiveSpy.mock.calls[0][0];
    // perPage === totalItems ⇒ totalPages === 1: pagination keys stay inert.
    expect(el.props.totalItems).toBe(2);
    expect(el.props.perPage).toBe(2);
    expect(el.props.initialRows).toHaveLength(2);
    expect(el.props.title).toBe('Skills Search \u00b7 "pdf"');
    expect(el.props.subtitle).toBe('2 skills \u00b7 install with: skills install <slug>');
  });

  it('loadPage replays the cached rows without remote access', async () => {
    await renderSkillsSearchInk(vm);
    const el = renderInteractiveSpy.mock.calls[0][0];
    const rows = await el.props.loadPage(1);
    expect(rows).toEqual(el.props.initialRows);
  });

  it('falls back to the one-shot static render for empty results', async () => {
    await renderSkillsSearchInk(emptyVm);
    expect(renderInteractiveSpy).not.toHaveBeenCalled();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });
});
