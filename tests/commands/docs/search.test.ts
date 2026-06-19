import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { DocsSearchResponse, DocContentResult } from '../../../src/types/docs.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { renderWithInkSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
}));

vi.mock('../../../src/services/index.js', () => ({
  createServices: () => holder.services,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: vi.fn(() => ({})),
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => {},
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: renderWithInkSpy,
  renderWithInkSync: renderWithInkSpy,
  renderInteractive: renderWithInkSpy,
}));

import { docsSearchAction } from '../../../src/commands/docs/search.js';

function build(program: import('commander').Command) {
  const docs = program.command('docs');
  const search = docs
    .command('search <query>')
    .option('--limit <n>', 'lim', (v) => parseInt(v, 10), 20)
    .option('--page <n>', 'p', (v) => parseInt(v, 10), 1)
    .option('--language <lang>')
    .option('--view <index>')
    .option('--format <fmt>');
  search.action(docsSearchAction(search));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

const sample: DocsSearchResponse = {
  totalCount: 1,
  page: 1,
  pageSize: 20,
  items: [
    {
      title: 'Quickstart',
      highlightedTitle: 'Quickstart',
      subBizType: 'doc',
      url: 'https://docs.test.qianwen.com/quickstart',
      summary: 'Get started with Qwen.',
      highlightedSummary: 'Get started with Qwen.',
      breadcrumb: ['Docs', 'Quickstart'],
    },
  ],
};

const sampleContent: DocContentResult = {
  url: 'https://docs.test.qianwen.com/quickstart',
  resolvedMarkdownUrl: 'https://docs.test.qianwen.com/quickstart.md',
  content: '# Quickstart\n\nHello.',
  error: null,
  anchor: null,
};

describe('docs search command', () => {
  it('JSON returns query/items/totalCount', async () => {
    holder.services = makeMockServices({
      docsService: { searchDocs: async () => sample },
    });
    const r = await runCommand(build, ['docs', 'search', 'qwen', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.query).toBe('qwen');
    expect(payload.totalCount).toBe(1);
    expect(payload.items).toHaveLength(1);
  });

  it('text mode renders without throwing', async () => {
    holder.services = makeMockServices({
      docsService: { searchDocs: async () => sample },
    });
    const r = await runCommand(build, ['docs', 'search', 'qwen', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
  });

  it('table mode invokes renderInteractive', async () => {
    holder.services = makeMockServices({
      docsService: { searchDocs: async () => sample },
    });
    const r = await runCommand(build, ['docs', 'search', 'qwen', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects empty query with stderr + exitCode 2', async () => {
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    holder.services = makeMockServices({
      docsService: { searchDocs: async () => sample },
    });
    const r = await runCommand(build, ['docs', 'search', '   ', '--format', 'json']);
    const finalExit = process.exitCode;
    process.exitCode = prevExit;
    expect(finalExit).toBe(2);
    expect(r.stderr).toContain('query is required');
  });

  it('--view fetches doc content (json mode)', async () => {
    holder.services = makeMockServices({
      docsService: {
        searchDocs: async () => sample,
        fetchDocContent: async () => sampleContent,
      },
    });
    const r = await runCommand(build, [
      'docs',
      'search',
      'qwen',
      '--view',
      '1',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.url).toBe(sampleContent.url);
    expect(payload.content).toContain('Quickstart');
  });

  it('--view out of range writes stderr + exitCode 1', async () => {
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    holder.services = makeMockServices({
      docsService: {
        searchDocs: async () => sample,
        fetchDocContent: async () => sampleContent,
      },
    });
    const r = await runCommand(build, [
      'docs',
      'search',
      'qwen',
      '--view',
      '99',
      '--format',
      'json',
    ]);
    const finalExit = process.exitCode;
    process.exitCode = prevExit;
    expect(finalExit).toBe(1);
    expect(r.stderr).toContain('out of range');
  });

  it('passes language to the service', async () => {
    const calls: Array<{ language?: string }> = [];
    holder.services = makeMockServices({
      docsService: {
        searchDocs: async (opts: { query: string; language?: string }) => {
          calls.push({ language: opts.language });
          return sample;
        },
      },
    });
    const r = await runCommand(build, [
      'docs',
      'search',
      'qwen',
      '--language',
      'zh',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(calls[0]).toMatchObject({ language: 'zh' });
  });
});
