import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { ConsumeBreakdown, ConsumeBreakdownByPeriods } from '../../../src/types/billing-extra.js';
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

import { billingBreakdownAction } from '../../../src/commands/billing/breakdown.js';

function build(program: import('commander').Command) {
  const billing = program.command('billing');
  const breakdown = billing
    .command('breakdown')
    .option('--granularity <g>', 'Granularity: day | month', 'month')
    .option('--group-by <dim>', '', 'model')
    .option('--from <date>')
    .option('--to <date>')
    .option('--period <preset>')
    .option('--charge-type <type>', '', 'all')
    .option('--top <n>', '', (v) => parseInt(v, 10), 10)
    .option('--format <fmt>');
  breakdown.action(billingBreakdownAction(breakdown));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest as any);
  clearRenderedFrames();
});

const sample: ConsumeBreakdown = {
  groupBy: 'model',
  period: { from: '2026-04-01', to: '2026-04-20' },
  chargeType: 'all',
  rows: [
    { groupKey: 'qwen3-max', groupLabel: 'qwen3-max', amount: '12.5' },
    { groupKey: 'qwen3-pro', groupLabel: 'qwen3-pro', amount: '7.25' },
  ],
  totalRows: 2,
  totalAmount: '19.75',
  currency: 'CNY',
};

const sampleByPeriods: ConsumeBreakdownByPeriods = {
  groupBy: 'model',
  dateRange: { from: '2026-01-01', to: '2026-06-30' },
  granularity: 'month',
  chargeType: 'all',
  slices: [
    {
      period: '2026-01',
      rows: [{ groupKey: 'qwen3-max', groupLabel: 'Qwen3 Max', amount: '10.00' }],
      totalAmount: '10.00',
    },
  ],
  currency: 'CNY',
};

describe('billing breakdown command', () => {
  describe('JSON mode', () => {
    it('returns full payload with rows and totals', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });

      const r = await runCommand(build, [
        'billing',
        'breakdown',
        '--granularity',
        'day',
        '--from',
        '2026-04-01',
        '--to',
        '2026-04-01',
        '--format',
        'json',
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
      const payload = JSON.parse(r.stdout);
      expect(payload.rows).toHaveLength(2);
      expect(payload.totalAmount).toBe('19.75');
      expect(payload.rows.every((r: { groupKey: string }) => r.groupKey !== '__tax__')).toBe(true);
      expect(spy).toHaveBeenCalledWith({
        groupBy: 'model',
        from: '2026-04-01',
        to: '2026-04-01',
        chargeType: 'all',
        top: 10,
        granularity: 'day',
      });
    });
  });

  describe('option parsing', () => {
    it('--period with --from → --from takes priority (no error)', async () => {
      const spy = vi.fn(async () => sampleByPeriods);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdownByPeriods: spy },
      });

      await runCommand(build, [
        'billing',
        'breakdown',
        '--granularity',
        'day',
        '--period',
        'month',
        '--from',
        '2026-04-01',
        '--to',
        '2026-04-30',
        '--format',
        'json',
      ]);
      expect(spy).toHaveBeenCalled();
      const arg = spy.mock.calls[0][0] as { from: string };
      expect(arg.from).toBe('2026-04-01');
    });

    it('uses defaultCurrentMonthCycle when no date opts (month granularity)', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });

      await runCommand(build, ['billing', 'breakdown', '--format', 'json']);
      const arg = spy.mock.calls[0][0] as { from: string; to: string };
      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      expect(arg.from).toContain(ym);
      expect(arg.to).toContain(ym);
    });

    it('falls back to model groupBy on unknown value', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });

      await runCommand(build, [
        'billing',
        'breakdown',
        '--group-by',
        'invalid-group',
        '--format',
        'json',
      ]);
      expect((spy.mock.calls[0][0] as { groupBy: string }).groupBy).toBe('model');
    });

    it('--charge-type subscription → service receives chargeType: prepaid', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });

      await runCommand(build, [
        'billing', 'breakdown', '--charge-type', 'subscription', '--format', 'json',
      ]);
      expect((spy.mock.calls[0][0] as { chargeType: string }).chargeType).toBe('prepaid');
    });

    it('--charge-type payg → service receives chargeType: postpaid', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });

      await runCommand(build, [
        'billing', 'breakdown', '--charge-type', 'payg', '--format', 'json',
      ]);
      expect((spy.mock.calls[0][0] as { chargeType: string }).chargeType).toBe('postpaid');
    });

    it('clamps --top to <= 100 and >= 1', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });

      await runCommand(build, ['billing', 'breakdown', '--top', '999', '--format', 'json']);
      expect((spy.mock.calls[0][0] as { top: number }).top).toBe(100);
    });
  });

  describe('granularity option', () => {
    it('default --granularity month → service receives granularity: month', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });
      await runCommand(build, ['billing', 'breakdown', '--format', 'json']);
      const opts = spy.mock.calls[0][0] as { granularity: string };
      expect(opts.granularity).toBe('month');
    });

    it('--granularity day → service receives granularity: day', async () => {
      const spy = vi.fn(async () => sampleByPeriods);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdownByPeriods: spy },
      });
      await runCommand(build, [
        'billing', 'breakdown', '--granularity', 'day', '--from', '2026-06-01', '--to', '2026-06-18', '--format', 'json',
      ]);
      const opts = spy.mock.calls[0][0] as { granularity: string };
      expect(opts.granularity).toBe('day');
    });

    it('default month granularity → from/to is current month (YYYY-MM)', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });
      await runCommand(build, ['billing', 'breakdown', '--format', 'json']);
      const opts = spy.mock.calls[0][0] as { from: string; to: string };
      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      expect(opts.from).toContain(ym);
      expect(opts.to).toContain(ym);
    });
  });

  describe('date validation', () => {
    it('time range exceeding 12 months (month granularity) → exit 1', async () => {
      const spy = vi.fn(async () => sample);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: spy },
      });
      const r = await runCommand(build, [
        'billing', 'breakdown', '--from', '2024-01', '--to', '2025-06', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    });

    it('time range exactly 12 months (month granularity) → passes through', async () => {
      const spy = vi.fn(async () => sampleByPeriods);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdownByPeriods: spy },
      });
      const r = await runCommand(build, [
        'billing', 'breakdown', '--from', '2025-06', '--to', '2026-06', '--format', 'json',
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(spy).toHaveBeenCalled();
    });

    it('invalid date format --from 20250 (month granularity) → exit 4', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--from', '20250', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
    });

    it('invalid date format --from 2025-1 (month granularity) → exit 4', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--from', '2025-1', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
    });

    it('invalid date format --from 202506 (month granularity) → exit 4', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--from', '202506', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
    });

    it('invalid date format --from 2025-13 (month granularity) → exit 4', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--from', '2025-13', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
    });

    it('invalid date format --from 2025-1-01 (day granularity) → exit 4', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--granularity', 'day', '--from', '2025-1-01', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
    });

    it('day granularity: time range exceeding 31 days → exit 4', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--granularity', 'day', '--from', '2026-05-01', '--to', '2026-06-18', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
    });

    it('day granularity: time range within 31 days → passes through', async () => {
      const spy = vi.fn(async () => sampleByPeriods);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdownByPeriods: spy },
      });
      const r = await runCommand(build, [
        'billing', 'breakdown', '--granularity', 'day', '--from', '2026-06-01', '--to', '2026-06-18', '--format', 'json',
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('period-granularity interaction', () => {
    it('--period week (< 31 days) without --granularity → auto day', async () => {
      const spy = vi.fn(async () => sampleByPeriods);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdownByPeriods: spy },
      });
      await runCommand(build, [
        'billing', 'breakdown', '--period', 'week', '--format', 'json',
      ]);
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[0][0] as { granularity: string };
      expect(opts.granularity).toBe('day');
    });

    it('--period week + --granularity day → no conflict', async () => {
      const spy = vi.fn(async () => sampleByPeriods);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdownByPeriods: spy },
      });
      const r = await runCommand(build, [
        'billing', 'breakdown', '--period', 'week', '--granularity', 'day', '--format', 'json',
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[0][0] as { granularity: string };
      expect(opts.granularity).toBe('day');
    });

    it('--period week + --granularity month → conflict error', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--period', 'week', '--granularity', 'month', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain('Parameter conflict');
    });

    it('--period quarter (>= 31 days) without --granularity → stays month', async () => {
      const spy = vi.fn(async () => sampleByPeriods);
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdownByPeriods: spy },
      });
      await runCommand(build, [
        'billing', 'breakdown', '--period', 'quarter', '--format', 'json',
      ]);
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[0][0] as { granularity: string };
      expect(opts.granularity).toBe('month');
    });

    it('--period quarter + --granularity day → conflict error', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--period', 'quarter', '--granularity', 'day', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain('Parameter conflict');
    });

    it('--period today + --granularity month → conflict error', async () => {
      const r = await runCommand(build, [
        'billing', 'breakdown', '--period', 'today', '--granularity', 'month', '--format', 'json',
      ]);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain('Parameter conflict');
    });
  });

  describe('rendering modes', () => {
    it('text mode renders without throwing', async () => {
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: async () => sample },
      });
      const r = await runCommand(build, [
        'billing',
        'breakdown',
        '--granularity',
        'day',
        '--from',
        '2026-04-01',
        '--to',
        '2026-04-01',
        '--format',
        'text',
      ]);
      expect(r.exitCode).toBeUndefined();
    });

    it('table mode invokes renderWithInk', async () => {
      holder.services = makeMockServices({
        billingService: { getConsumeBreakdown: async () => sample },
      });
      const r = await runCommand(build, [
        'billing',
        'breakdown',
        '--granularity',
        'day',
        '--from',
        '2026-04-01',
        '--to',
        '2026-04-01',
        '--format',
        'table',
      ]);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    });
  });
});
