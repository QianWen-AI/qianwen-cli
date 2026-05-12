import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockApiClient } from '../../helpers/api-client.js';
import type { ApiClient } from '../../../src/api/client.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';

const holder: { client: ApiClient } = { client: makeMockApiClient() };

// hoisted: shared spy for renderWithInk so we can swap impl per-test
const { renderWithInkSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
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
  renderWithInk: renderWithInkSpy,
  renderInteractive: vi.fn(),
  renderWithInkSync: renderWithInkSpy,
}));

const { usageSummaryAction } = await import('../../../src/commands/usage/summary.js');

beforeEach(() => {
  holder.client = makeMockApiClient();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

function buildSummary(program: import('commander').Command) {
  const usage = program.command('usage');
  const summary = usage
    .command('summary')
    .option('--from <date>')
    .option('--to <date>')
    .option('--period <p>');
  summary.action(usageSummaryAction(summary));
}

describe('usage summary command (one-shot)', () => {
  describe('JSON mode', () => {
    it('empty data → returns full payload structure with empty arrays, exit 0', async () => {
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
      const payload = JSON.parse(r.stdout);
      expect(payload).toHaveProperty('period');
      expect(payload).toHaveProperty('free_tier');
      expect(payload).toHaveProperty('token_plan');
      expect(payload).toHaveProperty('pay_as_you_go');
    });

    it('with free-tier + payg data → renders both, exit 0', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'qwen3-max', quota: { remaining: 500_000, total: 1_000_000, unit: 'tokens', used_pct: 50 } } as any,
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: {
            models: [
              {
                model_id: 'qwen3-max',
                usage: { tokens_in: 50_000, tokens_out: 10_000 },
                cost: 0.42,
                currency: 'CNY',
              },
            ],
            total: { cost: 0.42, currency: 'CNY' },
          },
        }),
      });

      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.free_tier).toHaveLength(1);
      expect(payload.pay_as_you_go.models).toHaveLength(1);
    });
  });

  describe('text mode', () => {
    it('empty data → renders period header (no crash), exit 0', async () => {
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
    });

    it('with data → renders period and table-like output to stdout, exit 0', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'qwen3-max', quota: { remaining: 500_000, total: 1_000_000, unit: 'tokens', used_pct: 50 } } as any,
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('qwen3-max');
    });
  });

  describe('date range', () => {
    it('--from/--to passed through to API client', async () => {
      let captured: { from?: string; to?: string } = {};
      holder.client = makeMockApiClient({
        getUsageSummary: async (opts) => {
          captured = { from: opts?.from, to: opts?.to };
          return {
            period: { from: opts?.from ?? '', to: opts?.to ?? '' },
            free_tier: [],
            token_plan: { subscribed: false },
            pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
          };
        },
      });
      const r = await runCommand(buildSummary, [
        'usage', 'summary', '--from', '2026-03-01', '--to', '2026-03-31', '--format', 'json',
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(captured.from).toBe('2026-03-01');
      expect(captured.to).toBe('2026-03-31');
    });
  });

  // ── extended branches: text rendering and section variants ─────────
  describe('text mode rendering', () => {
    it('token_plan section renders when subscribed', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: {
            subscribed: true,
            planName: 'Token Plan 团队版（月）',
            status: 'valid',
            totalCredits: 25000,
            remainingCredits: 25000,
            usedPct: 0,
            resetDate: '2026-06-01T00:00:00Z',
          },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      // Token Plan title appears in text rendering
      expect(r.stdout).toMatch(/Token Plan|valid/i);
    });

    it('payg-only data → renders Pay-as-you-go section', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: { subscribed: false },
          pay_as_you_go: {
            models: [
              {
                model_id: 'qwen3-max',
                usage: { tokens_in: 10_000, tokens_out: 2_000 },
                cost: 0.12,
                currency: 'CNY',
              },
            ],
            total: { cost: 0.12, currency: 'CNY' },
          },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('qwen3-max');
    });

    it('all sections together → all model ids appear', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'qwen-free', quota: { remaining: 800_000, total: 1_000_000, unit: 'tokens', used_pct: 20, resetDate: null } },
          ],
          token_plan: {
            subscribed: true,
            planName: 'Token Plan 团队版（月）',
            status: 'valid',
            totalCredits: 25000,
            remainingCredits: 25000,
            usedPct: 0,
            resetDate: '2026-06-01T00:00:00Z',
          },
          pay_as_you_go: {
            models: [{ model_id: 'qwen-payg', usage: { tokens_in: 100, tokens_out: 50 }, cost: 0.01, currency: 'CNY' }],
            total: { cost: 0.01, currency: 'CNY' },
          },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('qwen-free');
      expect(r.stdout).toContain('qwen-payg');
    });
  });

  describe('error path', () => {
    it('API client throws → exit 1, error to stderr', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => {
          throw new Error('boom');
        },
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('boom');
    });
  });

  // ── Ink rendering branches (table/TTY mode) ──────────────────────
  // These tests exercise the local Ink components inside summary.tsx
  // (UsageSummaryInk / FreeTierSection / TokenPlanSection / PayAsYouGoSection)
  // by replacing renderWithInk with a real ink-testing-library render.
  describe('Ink rendering (table mode)', () => {
    it('renders all sections (free_tier + payg + token_plan)', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'qwen3-max', quota: { remaining: 500_000, total: 1_000_000, unit: 'tokens', used_pct: 50 } } as any,
          ],
          token_plan: {
            subscribed: true,
            planName: 'Token Plan 团队版（月）',
            status: 'valid',
            totalCredits: 25000,
            remainingCredits: 25000,
            usedPct: 0,
            resetDate: '2026-06-01T00:00:00Z',
          },
          pay_as_you_go: {
            models: [
              { model_id: 'qwen3-payg', usage: { tokens_in: 100, tokens_out: 50 }, cost: 0.01, currency: 'CNY' },
            ],
            total: { cost: 0.01, currency: 'CNY' },
          },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      const el = renderWithInkSpy.mock.calls[0][0];
      // Element wraps a vm prop with all sections present
      expect(el.props.vm.freeTier).toBeTruthy();
      expect(el.props.vm.payAsYouGo).toBeTruthy();
      expect(el.props.vm.tokenPlan).toBeTruthy();
    });

    it('renders FreeTierSection with isFreeOnly row (mode=only / quota null)', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'qwen-free-only', quota: null } as any,
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    });

    it('renders FreeTierSection with hidden-count footer when >10 rows', async () => {
      const manyRows = Array.from({ length: 12 }, (_, i) => ({
        model_id: `qwen-free-${i}`,
        quota: { remaining: 500, total: 1000, unit: 'tokens', used_pct: 50 },
      })) as any[];
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: manyRows,
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      const el = renderWithInkSpy.mock.calls[0][0];
      expect(el.props.vm.freeTier.totalCount).toBe(12);
    });

    it('renders TokenPlanSection with addon credits', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: {
            subscribed: true,
            planName: 'Token Plan 团队版（月）',
            status: 'valid',
            totalCredits: 25000,
            remainingCredits: 25000,
            usedPct: 0,
            resetDate: '2026-06-01T00:00:00Z',
            addonRemaining: 1000,
          },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    });

    it('renders PayAsYouGoSection isEmpty branch', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: { subscribed: false },
          pay_as_you_go: {
            models: [],
            total: { cost: 0, currency: 'CNY' },
          },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    });

    it('renders PayAsYouGoSection with hidden-count footer when >10 rows', async () => {
      const manyPayg = Array.from({ length: 12 }, (_, i) => ({
        model_id: `qwen-payg-${i}`,
        usage: { tokens_in: 100, tokens_out: 50 },
        cost: 0.01,
        currency: 'CNY',
      }));
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [],
          token_plan: { subscribed: false },
          pay_as_you_go: {
            models: manyPayg,
            total: { cost: 0.12, currency: 'CNY' },
          },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
      const el = renderWithInkSpy.mock.calls[0][0];
      expect(el.props.vm.payAsYouGo.totalCount).toBe(12);
    });

    it('renders only FreeTierSection (no payg, no token plan) — single section path', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'qwen-only-ft', quota: { remaining: 100, total: 1000, unit: 'tokens', used_pct: 90 } } as any,
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildSummary, ['usage', 'summary', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    });
  });
});
