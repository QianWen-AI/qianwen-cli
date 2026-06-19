import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { SettleBillSummary } from '../../../src/types/billing-extra.js';
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

const { billingSummaryAction } = await import('../../../src/commands/billing/summary.js');

function build(program: import('commander').Command) {
  const billing = program.command('billing');
  const summary = billing
    .command('summary')
    .option('--from <cycle>')
    .option('--to <cycle>')
    .option('--charge-type <type>', '', 'all')
    .option('--format <fmt>');
  summary.action(billingSummaryAction(summary));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest as any);
  clearRenderedFrames();
});

const sample: SettleBillSummary = {
  cycles: [
    {
      billingCycle: '2026-04',
      pretaxAmount: '100.0',
      tax: '10.0',
      aftertaxAmount: '110.0',
    },
  ],
  totals: {
    pretaxAmount: '100.0',
    tax: '10.0',
    aftertaxAmount: '110.0',
  },
  currency: 'CNY',
  period: { from: '2026-04', to: '2026-04' },
  chargeType: 'all',
};

describe('billing summary command', () => {
  it('JSON returns the full SettleBillSummary payload', async () => {
    const spy = vi.fn(async () => sample);
    holder.services = makeMockServices({
      billingService: { getSettleBillSummary: spy },
    });
    const r = await runCommand(build, [
      'billing',
      'summary',
      '--from',
      '2026-04',
      '--to',
      '2026-04',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.stdout).cycles).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith({ from: '2026-04', to: '2026-04', chargeType: 'all' });
  });

  it('uses default current-month cycle when --from/--to omitted', async () => {
    const spy = vi.fn(async () => sample);
    holder.services = makeMockServices({
      billingService: { getSettleBillSummary: spy },
    });
    await runCommand(build, ['billing', 'summary', '--format', 'json']);
    const arg = spy.mock.calls[0][0] as { from: string; to: string };
    expect(arg.from).toMatch(/^\d{4}-\d{2}$/);
    expect(arg.to).toBe(arg.from);
  });

  it('ignores invalid YYYY-MM cycle and falls back to default', async () => {
    const spy = vi.fn(async () => sample);
    holder.services = makeMockServices({
      billingService: { getSettleBillSummary: spy },
    });
    await runCommand(build, [
      'billing',
      'summary',
      '--from',
      '2026/04/01',
      '--to',
      'oops',
      '--format',
      'json',
    ]);
    const arg = spy.mock.calls[0][0] as { from: string; to: string };
    expect(arg.from).toMatch(/^\d{4}-\d{2}$/);
    expect(arg.to).toMatch(/^\d{4}-\d{2}$/);
  });

  it('text mode renders without throwing', async () => {
    holder.services = makeMockServices({
      billingService: { getSettleBillSummary: async () => sample },
    });
    const r = await runCommand(build, ['billing', 'summary', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
  });

  it('table mode invokes renderWithInk', async () => {
    holder.services = makeMockServices({
      billingService: { getSettleBillSummary: async () => sample },
    });
    const r = await runCommand(build, ['billing', 'summary', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });
});
