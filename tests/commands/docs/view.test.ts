/**
 * Command-layer tests for `docs view <path>`.
 *
 * Coverage targets:
 *   1. `--format json` returns the documented payload shape (url /
 *      resolvedMarkdownUrl / contentType / content / anchor / error).
 *   2. `--format text` emits the `--- Source: <url> ---` header followed by
 *      the document body to stdout.
 *   3. `--format table` triggers the Ink interactive renderer with a
 *      DocsViewer-shaped element (vm / url / onQuit).
 *   4. path semantics: relative path → docs base URL prepended; full URL
 *      → passed through verbatim; anchor preserved.
 *   5. error contract:
 *        - HTTP 404 → exit code 10, error surfaced (JSON envelope or stderr)
 *        - network timeout → exit code 3
 *        - empty content → exit code 10
 *   6. command registration: `--help` does not crash and missing path is
 *      rejected by the argument parser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';
import type { DocContentResult, DocsIndexEntry } from '../../../src/types/docs.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { renderWithInkSpy, renderInteractiveSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
  renderInteractiveSpy: vi.fn<(el: any) => Promise<void>>(),
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
  renderInteractive: renderInteractiveSpy,
  renderWithInkSync: renderWithInkSpy,
}));

const { docsViewAction } = await import('../../../src/commands/docs/view.js');

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  renderInteractiveSpy.mockReset();
  renderInteractiveSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

function buildView(program: import('commander').Command) {
  const docs = program.command('docs');
  const view = docs
    .command('view <path>')
    .description('View a document by path')
    .option('--format <fmt>', 'Output format: table, json, text');
  view.action(docsViewAction(view));
}

const PRICING_PATH = 'developer-guides/getting-started/pricing';
const PRICING_URL = `https://mock-docs.test.qianwen.com/${PRICING_PATH}`;
const PRICING_MD = `${PRICING_URL}.md`;
const PRICING_BODY = '# Pricing\n\nPay-as-you-go pricing for API usage.';

function makeDocResult(overrides: Partial<DocContentResult> = {}): DocContentResult {
  return {
    url: PRICING_URL,
    resolvedMarkdownUrl: PRICING_MD,
    content: PRICING_BODY,
    error: null,
    anchor: null,
    ...overrides,
  };
}

describe('docs view command', () => {
  describe('command registration', () => {
    it('--help does not throw and does not invoke fetchDocContent', async () => {
      const fetchSpy = vi.fn(async () => makeDocResult());
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', '--help']);

      expect(r.exitCode).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('missing <path> positional argument is rejected', async () => {
      const r = await runCommand(buildView, ['docs', 'view']);
      expect(r.exitCode).toBeGreaterThan(0);
      expect(r.stderr).toContain('missing required argument');
    });
  });

  describe('JSON mode', () => {
    it('happy path → JSON includes url / resolvedMarkdownUrl / contentType / content / anchor / error', async () => {
      const fetchSpy = vi.fn(async (_url: string) => makeDocResult());
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', PRICING_PATH, '--format', 'json']);

      expect(r.exitCode).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const payload = JSON.parse(r.stdout);
      expect(payload).toHaveProperty('url');
      expect(payload).toHaveProperty('resolvedMarkdownUrl');
      expect(payload).toHaveProperty('contentType', 'markdown');
      expect(payload).toHaveProperty('content');
      expect(payload).toHaveProperty('anchor');
      expect(payload).toHaveProperty('error');
      expect(payload.content).toContain('Pricing');
      expect(payload.error).toBeNull();
    });

    it('relative path is composed against the docs base URL before fetching', async () => {
      const fetchSpy = vi.fn(async (url: string) => makeDocResult({ url }));
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      await runCommand(buildView, ['docs', 'view', PRICING_PATH, '--format', 'json']);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const requestedUrl = fetchSpy.mock.calls[0][0];
      expect(requestedUrl).toContain(PRICING_PATH);
      expect(requestedUrl.startsWith('http')).toBe(true);
    });

    it('full URL path is passed through verbatim, preserving .md', async () => {
      const directUrl = 'https://platform.qianwenai.com/docs/resources/free-quota.md';
      const fetchSpy = vi.fn(async (url: string) =>
        makeDocResult({ url, resolvedMarkdownUrl: url, content: '# Free Quota\n' }),
      );
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', directUrl, '--format', 'json']);

      expect(r.exitCode).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledWith(directUrl);
      const payload = JSON.parse(r.stdout);
      expect(payload.url).toBe(directUrl);
    });

    it('anchor in path is preserved in the JSON anchor field', async () => {
      const pathWithAnchor = 'api-reference/chat/openai-chat#streaming';
      const fetchSpy = vi.fn(async (url: string) =>
        makeDocResult({
          url,
          resolvedMarkdownUrl: url.split('#')[0] + '.md',
          content: '# OpenAI Chat\n\n## Streaming\n\nDetails',
          anchor: 'streaming',
        }),
      );
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', pathWithAnchor, '--format', 'json']);

      const payload = JSON.parse(r.stdout);
      expect(payload.anchor).toBe('streaming');
    });

    it('HTTP 404 → exit code 10 and error info surfaces', async () => {
      const fetchSpy = vi.fn(async (url: string) =>
        makeDocResult({ url, content: null, error: 'HTTP 404' }),
      );
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, [
        'docs',
        'view',
        'nonexistent-path',
        '--format',
        'json',
      ]);

      expect(r.exitCode).toBe(10);
      const combined = r.stdout + r.stderr;
      expect(combined).toMatch(/404|not found/i);
    });

    it('network timeout → exit code 3', async () => {
      const fetchSpy = vi.fn(async (url: string) =>
        makeDocResult({ url, content: null, error: 'Request timed out' }),
      );
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', PRICING_PATH, '--format', 'json']);

      expect(r.exitCode).toBe(3);
      const combined = r.stdout + r.stderr;
      expect(combined).toMatch(/tim(e|ed)\s?out/i);
    });

    it('empty content → exit code 10', async () => {
      const fetchSpy = vi.fn(async (url: string) =>
        makeDocResult({ url, content: '', error: null }),
      );
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', PRICING_PATH, '--format', 'json']);

      expect(r.exitCode).toBe(10);
      const combined = r.stdout + r.stderr;
      expect(combined).toMatch(/empty/i);
    });
  });

  describe('TEXT mode', () => {
    it('happy path → stdout contains the Source header followed by the body', async () => {
      const fetchSpy = vi.fn(async (url: string) => makeDocResult({ url }));
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', PRICING_PATH, '--format', 'text']);

      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('---');
      expect(r.stdout).toContain('Source:');
      expect(r.stdout).toContain('Pricing');
      expect(r.stdout).toContain('Pay-as-you-go');
    });

    it('HTTP 404 in TEXT mode → error to stderr, non-zero exit', async () => {
      const fetchSpy = vi.fn(async (url: string) =>
        makeDocResult({ url, content: null, error: 'HTTP 404' }),
      );
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', 'nonexistent', '--format', 'text']);

      expect(r.exitCode).toBe(10);
      expect(r.stderr).toMatch(/404|not found/i);
    });
  });

  describe('table mode (Ink interactive)', () => {
    it('triggers renderInteractive once with a DocsViewer element carrying url + content', async () => {
      const fetchSpy = vi.fn(async (url: string) => makeDocResult({ url }));
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: async () => [] },
      });

      const r = await runCommand(buildView, ['docs', 'view', PRICING_PATH, '--format', 'table']);

      expect(r.exitCode).toBeUndefined();
      expect(renderInteractiveSpy).toHaveBeenCalledTimes(1);

      const el = renderInteractiveSpy.mock.calls[0][0];
      // DocsViewer prop contract: { vm, url, onBack?, onQuit }.
      expect(el).toBeTruthy();
      expect(el.props).toBeDefined();
      expect(typeof el.props.url).toBe('string');
      expect(el.props.url).toContain(PRICING_PATH);
      expect(el.props.vm).toBeDefined();
      expect(el.props.vm.content).toContain('Pricing');
      expect(typeof el.props.onQuit).toBe('function');
    });
  });

  describe('llms.txt index integration', () => {
    function buildIndex(): DocsIndexEntry[] {
      return [
        {
          path: 'developer-guides/getting-started/pricing',
          fullUrl: 'https://mock-docs.test.qianwen.com/developer-guides/getting-started/pricing.md',
          title: 'Pricing',
          description: 'Pay-as-you-go pricing for API usage',
          section: 'Getting Started',
        },
        {
          path: 'token-plan/overview',
          fullUrl: 'https://mock-docs.test.qianwen.com/token-plan/overview.md',
          title: 'Token Plan Overview',
          description: 'Token Plan subscription overview',
          section: 'Token Plan',
        },
        {
          path: 'subscription/overview',
          fullUrl: 'https://mock-docs.test.qianwen.com/subscription/overview.md',
          title: 'Subscription Overview',
          description: 'Subscription overview',
          section: 'Subscription',
        },
        {
          path: 'resources/faq-billing',
          fullUrl: 'https://mock-docs.test.qianwen.com/resources/faq-billing.md',
          title: 'Billing FAQ',
          description: 'Payments and costs Q&A',
          section: 'Resources',
        },
      ];
    }

    it('exact-path input fetches the resolved document body', async () => {
      const loadIndexSpy = vi.fn(async () => buildIndex());
      const fetchSpy = vi.fn(async (url: string) => makeDocResult({ url }));
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: loadIndexSpy },
      });

      const r = await runCommand(buildView, [
        'docs',
        'view',
        'developer-guides/getting-started/pricing',
        '--format',
        'json',
      ]);

      expect(r.exitCode).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(r.stdout);
      expect(payload.content).toContain('Pricing');
    });

    it('ambiguous suffix input emits a candidates payload without fetching', async () => {
      const loadIndexSpy = vi.fn(async () => buildIndex());
      const fetchSpy = vi.fn(async (url: string) => makeDocResult({ url }));
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: loadIndexSpy },
      });

      // 'overview' suffix-matches both token-plan/overview and subscription/overview.
      const r = await runCommand(buildView, ['docs', 'view', 'overview', '--format', 'json']);

      // Ambiguous resolution must surface candidates rather than fetching a guess.
      expect(fetchSpy).not.toHaveBeenCalled();
      const combined = r.stdout + r.stderr;
      expect(combined).toContain('token-plan/overview');
      expect(combined).toContain('subscription/overview');
    });

    it('typo input with no fetch hit emits Did-you-mean suggestions and exits 10', async () => {
      const loadIndexSpy = vi.fn(async () => buildIndex());
      const fetchSpy = vi.fn(async (url: string) =>
        makeDocResult({ url, content: null, error: 'HTTP 404' }),
      );
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: loadIndexSpy },
      });

      const r = await runCommand(buildView, ['docs', 'view', 'pricng', '--format', 'json']);

      expect(r.exitCode).toBe(10);
      const combined = r.stdout + r.stderr;
      expect(combined).toMatch(/did you mean|suggest/i);
      expect(combined).toContain('pricing');
    });

    it('empty index degrades silently and lets the command fall through to fetch', async () => {
      const loadIndexSpy = vi.fn(async () => [] as DocsIndexEntry[]);
      const fetchSpy = vi.fn(async (url: string) => makeDocResult({ url }));
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: loadIndexSpy },
      });

      const r = await runCommand(buildView, ['docs', 'view', PRICING_PATH, '--format', 'json']);

      expect(r.exitCode).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(r.stdout);
      expect(payload.content).toContain('Pricing');
    });

    it('input absent from the index but reachable via fetch returns content normally', async () => {
      // The index intentionally lacks 'experimental/preview-feature'; the command
      // must still attempt to fetch (per the documented "index may be incomplete"
      // tolerance) and return the body when the upstream serves it.
      const loadIndexSpy = vi.fn(async () => buildIndex());
      const fetchSpy = vi.fn(async (url: string) =>
        makeDocResult({ url, content: '# Preview Feature\n\nDetails.' }),
      );
      holder.services = makeMockServices({
        docsService: { fetchDocContent: fetchSpy, loadDocsIndex: loadIndexSpy },
      });

      const r = await runCommand(buildView, [
        'docs',
        'view',
        'experimental/preview-feature',
        '--format',
        'json',
      ]);

      expect(r.exitCode).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(r.stdout);
      expect(payload.content).toContain('Preview Feature');
    });
  });
});
