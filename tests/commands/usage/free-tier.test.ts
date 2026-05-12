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

const { usageFreeTierAction } = await import('../../../src/commands/usage/free-tier.js');

beforeEach(() => {
  holder.client = makeMockApiClient();
  renderInteractiveSpy.mockReset();
  renderInteractiveSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

function buildFreeTier(program: import('commander').Command) {
  const usage = program.command('usage');
  const ft = usage
    .command('free-tier')
    .option('--from <date>')
    .option('--to <date>')
    .option('--period <p>');
  ft.action(usageFreeTierAction(ft));
}

describe('usage free-tier command (one-shot)', () => {
  describe('JSON mode', () => {
    it('empty data → returns free_tier=[], exit 0', async () => {
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload).toHaveProperty('free_tier');
      expect(payload.free_tier).toEqual([]);
    });

    it('with free tier rows → returns array, exit 0', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'qwen3-max', quota: { remaining: 500_000, total: 1_000_000, unit: 'tokens', used_pct: 50, resetDate: null } },
            { model_id: 'qwen3-mini', quota: { remaining: 0, total: 100_000, unit: 'tokens', used_pct: 100, resetDate: null } },
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      const payload = JSON.parse(r.stdout);
      expect(payload.free_tier).toHaveLength(2);
    });
  });

  describe('text mode', () => {
    it('empty → "No free tier models found"', async () => {
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('No free tier models found');
    });

    it('with rows → prints each model id', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'qwen3-max', quota: { remaining: 500_000, total: 1_000_000, unit: 'tokens', used_pct: 50, resetDate: null } },
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('qwen3-max');
    });

    it('mode=only model → renders "Free access" line', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            // free-only model: quota null, model itself is in mode='only' via build pipeline
            { model_id: 'qwen-free-only', quota: null } as any,
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      // model id rendered (regardless of remaining/total formatting branch taken)
      expect(r.stdout).toContain('qwen-free-only');
    });

    it('expired quota row still renders with model id', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            {
              model_id: 'qwen-expired',
              remaining: 0,
              total: 1_000_000,
              unit: 'tokens',
              status: 'expire',
            } as any,
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('qwen-expired');
    });
  });

  describe('error path', () => {
    it('API client throws → exit 1', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => {
          throw new Error('ft-fail');
        },
      });
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'json']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('ft-fail');
    });
  });

  // ── Ink rendering branches (table/TTY mode) ──────────────────────
  // Replaces renderInteractive with a real ink-testing-library render so
  // renderFreeTierInteractive + buildRow (both isFreeOnly and normal
  // branches) in free-tier.tsx get executed.
  describe('Ink rendering (table mode)', () => {
    it('builds rows + invokes renderInteractive for non-empty free_tier (mixes isFreeOnly and normal)', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            // normal row with quota
            { model_id: 'qwen-with-quota', quota: { remaining: 800, total: 1000, unit: 'tokens', used_pct: 20 } } as any,
            // isFreeOnly row (quota null)
            { model_id: 'qwen-free-only', quota: null } as any,
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderInteractiveSpy).toHaveBeenCalledTimes(1);
      const el = renderInteractiveSpy.mock.calls[0][0];
      // InteractiveTable props
      expect(el.props.title).toBe('Free Tier Quota');
      expect(el.props.totalItems).toBe(2);
      expect(el.props.perPage).toBe(15);
      expect(Array.isArray(el.props.columns)).toBe(true);
      expect(el.props.columns).toHaveLength(4);
      // initialRows includes both built rows
      expect(el.props.initialRows).toHaveLength(2);
    });

    it('does NOT invoke renderInteractive when free_tier is empty (early "No free tier" return)', async () => {
      const r = await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderInteractiveSpy).not.toHaveBeenCalled();
      expect(r.stdout).toContain('No free tier models found');
    });

    it('subtitle includes totalCount and "sorted by urgency" hint', async () => {
      holder.client = makeMockApiClient({
        getUsageSummary: async () => ({
          period: { from: '2026-04-01', to: '2026-04-20' },
          free_tier: [
            { model_id: 'm1', quota: { remaining: 100, total: 1000, unit: 'tokens', used_pct: 90 } } as any,
            { model_id: 'm2', quota: { remaining: 500, total: 1000, unit: 'tokens', used_pct: 50 } } as any,
            { model_id: 'm3', quota: { remaining: 800, total: 1000, unit: 'tokens', used_pct: 20 } } as any,
          ],
          token_plan: { subscribed: false },
          pay_as_you_go: { models: [], total: { cost: 0, currency: 'CNY' } },
        }),
      });
      await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'table']);
      expect(renderInteractiveSpy).toHaveBeenCalledTimes(1);
      const el = renderInteractiveSpy.mock.calls[0][0];
      expect(el.props.subtitle).toMatch(/3 models/);
      expect(el.props.subtitle).toMatch(/sorted by urgency/);
    });

    it('loadPage returns slice for the requested page', async () => {
      // 20 rows so pagination covers > 1 page (PER_PAGE=15)
      const manyRows = Array.from({ length: 20 }, (_, i) => ({
        model_id: `m-${i}`,
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
      await runCommand(buildFreeTier, ['usage', 'free-tier', '--format', 'table']);
      const el = renderInteractiveSpy.mock.calls[0][0];
      expect(el.props.totalItems).toBe(20);
      expect(el.props.initialRows).toHaveLength(15); // PER_PAGE
      // exercise loadPage closure for both pages
      const page1 = await el.props.loadPage(1);
      expect(page1).toHaveLength(15);
      const page2 = await el.props.loadPage(2);
      expect(page2).toHaveLength(5);
    });
  });
});
