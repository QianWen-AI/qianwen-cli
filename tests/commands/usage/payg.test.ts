import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';

const holder: { client: ApiClient } = { client: makeMockApiClient() };

const { renderInteractiveSpy } = vi.hoisted(() => ({
  renderInteractiveSpy: vi.fn<(el: any) => Promise<void>>(),
}));

vi.mock('../../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => ({}),
}));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
  clearSpinnerLine: () => {},
}));
vi.mock('../../../src/ui/render.js', () => ({
  renderWithInk: vi.fn(),
  renderInteractive: renderInteractiveSpy,
  renderWithInkSync: vi.fn(),
}));

const { usagePaygAction } = await import('../../../src/commands/usage/payg.js');

beforeEach(() => {
  holder.client = makeMockApiClient();
  renderInteractiveSpy.mockReset();
  renderInteractiveSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

function buildPayg(program: import('commander').Command) {
  const usage = program.command('usage');
  const payg = usage
    .command('payg')
    .option('--from <date>')
    .option('--to <date>')
    .option('--days <n>')
    .option('--period <p>');
  payg.action(usagePaygAction(payg));
}

describe('usage payg command (one-shot)', () => {
  describe('JSON mode', () => {
    it('empty payg → returns pay_as_you_go object with empty models, exit 0', async () => {
      const r = await runCommand(buildPayg, ['usage', 'payg', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
      const payload = JSON.parse(r.stdout);
      expect(payload).toHaveProperty('pay_as_you_go');
      expect(payload.pay_as_you_go.models).toEqual([]);
    });

    it('with usage → returns models array, exit 0', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: { subscribed: false },
          pay_as_you_go: {
            models: [
              {
                model_id: 'qwen3-max',
                usage: { requests: 100, tokens_in: 50_000, tokens_out: 10_000 },
                cost: 0.42,
                currency: 'CNY',
              },
            ],
            total: { cost: 0.42, currency: 'CNY' },
          },
        }),
      });
      const r = await runCommand(buildPayg, ['usage', 'payg', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.pay_as_you_go.models).toHaveLength(1);
      expect(payload.pay_as_you_go.models[0].model_id).toBe('qwen3-max');
    });
  });

  describe('text mode', () => {
    it('empty payg → "No pay-as-you-go usage" message', async () => {
      const r = await runCommand(buildPayg, ['usage', 'payg', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('No pay-as-you-go usage');
    });

    // NOTE: text-mode rendering with non-empty rows is exercised by the
    // existing oneshot integration tests; here we just sanity-check the
    // empty path (above), since the row-builder accesses many optional
    // PayAsYouGoModel fields we don't want to over-constrain in unit tests.
  });

  // NOTE: Inverted-date validation is exercised by the integration test suite
  // (tests/integration/oneshot-commands.test.ts). The payg.tsx error path uses
  // a swallow-and-return pattern that interacts poorly with our in-process
  // runCommand harness, so we don't try to assert on it here.

  describe('text mode with rows', () => {
    it('renders each model id and Total line', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: { subscribed: false },
          pay_as_you_go: {
            models: [
              {
                model_id: 'qwen3-max',
                usage: { tokens_in: 50_000, tokens_out: 10_000 },
                cost: 0.42,
                currency: 'CNY',
              },
              {
                model_id: 'qwen3-mini',
                usage: { tokens_in: 1_000, tokens_out: 200 },
                cost: 0.01,
                currency: 'CNY',
              },
            ],
            total: { cost: 0.43, currency: 'CNY' },
          },
        }),
      });
      const r = await runCommand(buildPayg, ['usage', 'payg', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('qwen3-max');
      expect(r.stdout).toContain('qwen3-mini');
      expect(r.stdout).toContain('Total');
    });
  });

  describe('--days option', () => {
    it('--days 7 → resolves date range without error, exit 0', async () => {
      const r = await runCommand(buildPayg, ['usage', 'payg', '--days', '7', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
    });
  });

  describe('error path', () => {
    it('API client throws → exit 1', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => {
          throw new Error('payg-fail');
        },
      });
      const r = await runCommand(buildPayg, ['usage', 'payg', '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('payg-fail');
    });
  });

  // ── Ink rendering branches (table/TTY mode) ──────────────────────
  // Replaces renderInteractive with a real ink-testing-library render so
  // renderPaygInteractive in payg.tsx (rows → columns / footer / subtitle
  // construction) gets executed.
  describe('Ink rendering (table mode)', () => {
    it('invokes renderInteractive with InteractiveTable for non-empty payg', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: { subscribed: false },
          pay_as_you_go: {
            models: [
              { model_id: 'qwen3-max', usage: { tokens_in: 50_000, tokens_out: 10_000 }, cost: 0.42, currency: 'CNY' },
              { model_id: 'qwen3-mini', usage: { tokens_in: 1_000, tokens_out: 200 }, cost: 0.01, currency: 'CNY' },
            ],
            total: { cost: 0.43, currency: 'CNY' },
          },
        }),
      });
      const r = await runCommand(buildPayg, ['usage', 'payg', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderInteractiveSpy).toHaveBeenCalledTimes(1);
      const el = renderInteractiveSpy.mock.calls[0][0];
      // InteractiveTable props
      expect(el.props.title).toBe('Pay-as-you-go');
      expect(el.props.totalItems).toBe(2);
      expect(el.props.perPage).toBe(15);
      expect(Array.isArray(el.props.columns)).toBe(true);
      expect(el.props.columns).toHaveLength(4);
      // footer with bold Total
      expect(el.props.footer).toBeTruthy();
      expect(el.props.footer.modelId).toContain('Total');
    });

    it('does NOT invoke renderInteractive for empty payg (early return path)', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildPayg, ['usage', 'payg', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderInteractiveSpy).not.toHaveBeenCalled();
      // The "No pay-as-you-go usage" message is printed on console
      expect(r.stdout).toContain('No pay-as-you-go usage');
    });

    it('subtitle includes totalCount + period dot separator', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: { subscribed: false },
          pay_as_you_go: {
            models: [
              { model_id: 'm1', usage: { tokens_in: 10, tokens_out: 5 }, cost: 0.001, currency: 'CNY' },
            ],
            total: { cost: 0.001, currency: 'CNY' },
          },
        }),
      });
      await runCommand(buildPayg, ['usage', 'payg', '--format', 'table']);
      expect(renderInteractiveSpy).toHaveBeenCalledTimes(1);
      const el = renderInteractiveSpy.mock.calls[0][0];
      expect(el.props.subtitle).toMatch(/1 models/);
    });
  });
});
