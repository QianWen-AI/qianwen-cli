import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { SubscriptionOrders } from '../../../src/types/subscription.js';
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

const { subscriptionOrdersAction } = await import('../../../src/commands/subscription/orders.js');

function build(program: import('commander').Command) {
  const sub = program.command('subscription');
  const orders = sub
    .command('orders')
    .option('--from <date>')
    .option('--to <date>')
    .option('--type <kind>')
    .option('--page <n>', '', (v) => parseInt(v, 10), 1)
    .option('--page-size <n>', '', (v) => parseInt(v, 10), 20)
    .option('--format <fmt>');
  orders.action(subscriptionOrdersAction(orders));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

const sample: SubscriptionOrders = {
  orders: [
    {
      orderId: 'O1',
      orderType: 'purchase',
      orderTime: '2026-04-10T12:00:00Z',
      amount: '99.0',
      currency: 'CNY',
      status: 'paid',
    },
  ],
  pagination: { page: 1, pageSize: 20, total: 1 },
};

describe('subscription orders command', () => {
  it('JSON returns the SubscriptionOrders payload', async () => {
    const spy = vi.fn(async () => sample);
    holder.services = makeMockServices({
      subscriptionService: { listOrders: spy },
    });
    const r = await runCommand(build, ['subscription', 'orders', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.orders).toHaveLength(1);
    expect(spy).toHaveBeenCalledOnce();
    const arg = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.page).toBe(1);
    expect(arg.pageSize).toBe(20);
  });

  it('forwards the token-plan commodityCodeList filter to the service', async () => {
    const spy = vi.fn(async () => sample);
    holder.services = makeMockServices({
      subscriptionService: { listOrders: spy },
    });
    await runCommand(build, ['subscription', 'orders', '--format', 'json']);
    const arg = spy.mock.calls[0][0] as { commodityCodeList?: string };
    expect(arg.commodityCodeList).toBe('sfm_tokenplanteams_dp_cn,sfm_tokenplanteamsaddon_dp_cn');
  });

  it('clamps --page-size to MAX (>100 rejected)', async () => {
    const r = await runCommand(build, [
      'subscription',
      'orders',
      '--page-size',
      '500',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeGreaterThan(0);
    expect(r.stderr).toContain('page-size');
  });

  it('passes --type filter through when valid', async () => {
    const spy = vi.fn(async () => sample);
    holder.services = makeMockServices({
      subscriptionService: { listOrders: spy },
    });
    await runCommand(build, ['subscription', 'orders', '--type', 'purchase', '--format', 'json']);
    const arg = spy.mock.calls[0][0] as { type?: string };
    expect(arg.type).toBe('purchase');
  });

  it('drops invalid --type value', async () => {
    const spy = vi.fn(async () => sample);
    holder.services = makeMockServices({
      subscriptionService: { listOrders: spy },
    });
    await runCommand(build, ['subscription', 'orders', '--type', 'invalid', '--format', 'json']);
    const arg = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.type).toBeUndefined();
  });

  it('text mode renders without throwing', async () => {
    holder.services = makeMockServices({
      subscriptionService: { listOrders: async () => sample },
    });
    const r = await runCommand(build, ['subscription', 'orders', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
  });

  it('table mode invokes renderWithInk', async () => {
    holder.services = makeMockServices({
      subscriptionService: { listOrders: async () => sample },
    });
    const r = await runCommand(build, ['subscription', 'orders', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });
});
