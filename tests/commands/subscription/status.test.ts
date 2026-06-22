import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { SubscriptionStatusResult } from '../../../src/types/subscription.js';
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

const { subscriptionStatusAction } = await import('../../../src/commands/subscription/status.js');

function build(program: import('commander').Command) {
  const sub = program.command('subscription');
  const status = sub.command('status').option('--plan <kind>').option('--format <fmt>');
  status.action(subscriptionStatusAction(status));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

const sampleResult: SubscriptionStatusResult = {
  data: {
    isGray: true,
    plan: 'token-basic',
    period: { start: '2026-04-01', end: '2026-05-01' },
    quota: { remaining: 500_000, total: 1_000_000, usedPct: 50 },
    autoRenew: true,
    renewable: true,
  },
  diagnostics: [],
};

describe('subscription status command', () => {
  it('JSON returns the SubscriptionStatusResult', async () => {
    const spy = vi.fn(async () => sampleResult);
    holder.services = makeMockServices({
      subscriptionService: { getStatus: spy },
    });
    const r = await runCommand(build, ['subscription', 'status', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.plan).toBe('token-basic');
    expect(payload.diagnostics).toEqual([]);
    expect(spy).toHaveBeenCalledWith({});
  });

  it('passes --plan token through to the service', async () => {
    const spy = vi.fn(async () => sampleResult);
    holder.services = makeMockServices({
      subscriptionService: { getStatus: spy },
    });
    await runCommand(build, ['subscription', 'status', '--plan', 'token', '--format', 'json']);
    expect(spy).toHaveBeenCalledWith({ plan: 'token' });
  });

  it('ignores unknown --plan values', async () => {
    const spy = vi.fn(async () => sampleResult);
    holder.services = makeMockServices({
      subscriptionService: { getStatus: spy },
    });
    await runCommand(build, ['subscription', 'status', '--plan', 'enterprise', '--format', 'json']);
    expect(spy).toHaveBeenCalledWith({});
  });

  it('JSON exits 1 when data is null (no subscription)', async () => {
    holder.services = makeMockServices({
      subscriptionService: {
        getStatus: async () => ({ data: null, diagnostics: [] }),
      },
    });
    const r = await runCommand(build, ['subscription', 'status', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stdout);
    expect(payload.data).toBeNull();
  });

  it('text mode renders without throwing for valid data', async () => {
    holder.services = makeMockServices({
      subscriptionService: { getStatus: async () => sampleResult },
    });
    const r = await runCommand(build, ['subscription', 'status', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
  });

  it('table mode invokes renderWithInk', async () => {
    holder.services = makeMockServices({
      subscriptionService: { getStatus: async () => sampleResult },
    });
    const r = await runCommand(build, ['subscription', 'status', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });
});
