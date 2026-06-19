import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { UsageLimit } from '../../../src/types/billing-extra.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';

// ── Mocks (hoisted) ─────────────────────────────────────────────────
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

import { billingLimitAction } from '../../../src/commands/billing/limit.js';

function build(program: import('commander').Command) {
  const billing = program.command('billing');
  const limit = billing.command('limit').option('--format <fmt>');
  limit.action(billingLimitAction(limit));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest as any);
  clearRenderedFrames();
});

const sampleLimit: UsageLimit = {
  status: 'normal',
  limitAmount: '500.00',
  currency: 'CNY',
  alertThreshold: '80',
};

describe('billing limit command', () => {
  describe('JSON mode', () => {
    it('returns the raw service payload', async () => {
      holder.services = makeMockServices({
        billingService: { getUsageLimit: async () => sampleLimit },
      });

      const r = await runCommand(build, ['billing', 'limit', '--format', 'json']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual(sampleLimit);
    });

    it('returns null limitAmount for unset accounts', async () => {
      holder.services = makeMockServices({
        billingService: {
          getUsageLimit: async () => ({ ...sampleLimit, limitAmount: null }),
        },
      });

      const r = await runCommand(build, ['billing', 'limit', '--format', 'json']);
      const payload = JSON.parse(r.stdout);
      expect(payload.limitAmount).toBeNull();
    });
  });

  describe('text mode', () => {
    it('renders without crashing', async () => {
      holder.services = makeMockServices({
        billingService: { getUsageLimit: async () => sampleLimit },
      });

      const r = await runCommand(build, ['billing', 'limit', '--format', 'text']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');
    });
  });

  describe('table mode', () => {
    it('routes to renderWithInk for the Ink component', async () => {
      holder.services = makeMockServices({
        billingService: { getUsageLimit: async () => sampleLimit },
      });

      const r = await runCommand(build, ['billing', 'limit', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('upstream rejection is funnelled through handleError', async () => {
      holder.services = makeMockServices({
        billingService: {
          getUsageLimit: async () => {
            throw new Error('boom');
          },
        },
      });

      const r = await runCommand(build, ['billing', 'limit', '--format', 'json']);
      expect(r.exitCode).toBeGreaterThan(0);
      expect(r.stderr.length).toBeGreaterThan(0);
    });
  });
});
