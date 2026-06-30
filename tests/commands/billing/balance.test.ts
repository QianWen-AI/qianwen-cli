import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import { transformBalanceSummary } from '../../../src/api/adapters/billing-adapter.js';
import type { GetFundAccountAvailableAmountResponse } from '../../../src/types/balance.js';
import { renderInkForTest, clearRenderedFrames } from '../../helpers/ink-render-mock.js';

const holder: { services: ServiceContainer } = { services: makeMockServices() };

const { renderWithInkSpy, openBrowserSpy } = vi.hoisted(() => ({
  renderWithInkSpy: vi.fn<(el: any) => Promise<void>>(),
  openBrowserSpy: vi.fn(),
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
vi.mock('../../../src/utils/open-browser.js', () => ({
  openBrowser: openBrowserSpy,
}));

const { balanceSummaryAction } = await import('../../../src/commands/billing/balance/summary.js');
const { balanceRechargeAction } = await import('../../../src/commands/billing/balance/recharge.js');

function buildSummary(program: import('commander').Command) {
  const billing = program.command('billing');
  const balance = billing.command('balance');
  const summary = balance.command('summary').option('--format <fmt>');
  summary.action(balanceSummaryAction(summary));
}

function buildRecharge(program: import('commander').Command) {
  const billing = program.command('billing');
  const balance = billing.command('balance');
  const recharge = balance.command('recharge').option('--format <fmt>');
  recharge.action(balanceRechargeAction(recharge));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest as any);
  openBrowserSpy.mockReset();
  clearRenderedFrames();
});

// ────────────────────────────────────────────────────────────────────
// transformBalanceSummary adapter tests
// ────────────────────────────────────────────────────────────────────

describe('transformBalanceSummary', () => {
  it('normalizes values to camelCase DTO', () => {
    const raw: GetFundAccountAvailableAmountResponse = {
      AvailableAmount: '2614.13',
      Currency: 'CNY',
    };
    expect(transformBalanceSummary(raw)).toEqual({
      availableAmount: '2614.13',
      currency: 'CNY',
    });
  });

  it('falls back to defaults for null input', () => {
    expect(transformBalanceSummary(null)).toEqual({
      availableAmount: '0',
      currency: 'CNY',
    });
  });

  it('falls back to defaults for undefined input', () => {
    expect(transformBalanceSummary(undefined)).toEqual({
      availableAmount: '0',
      currency: 'CNY',
    });
  });

  it('defaults currency to CNY when field is missing', () => {
    const raw = { AvailableAmount: '100' } as GetFundAccountAvailableAmountResponse;
    const result = transformBalanceSummary(raw);
    expect(result.availableAmount).toBe('100');
    expect(result.currency).toBe('CNY');
  });

  it('falls back to defaults for empty object', () => {
    const raw = {} as GetFundAccountAvailableAmountResponse;
    expect(transformBalanceSummary(raw)).toEqual({
      availableAmount: '0',
      currency: 'CNY',
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// billing balance summary command tests
// ────────────────────────────────────────────────────────────────────

describe('billing balance summary', () => {
  const balanceData = { availableAmount: '2614.13', currency: 'CNY' };

  it('returns available amount and currency with --format json', async () => {
    const spy = vi.fn(async () => balanceData);
    holder.services = makeMockServices({
      billingService: { getAvailableBalance: spy },
    });
    const r = await runCommand(buildSummary, [
      'billing',
      'balance',
      'summary',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.stdout)).toEqual({
      availableAmount: '2614.13',
      currency: 'CNY',
    });
  });

  it('outputs AVAILABLE AMOUNT with amount in text format', async () => {
    holder.services = makeMockServices({
      billingService: { getAvailableBalance: async () => balanceData },
    });
    const r = await runCommand(buildSummary, [
      'billing',
      'balance',
      'summary',
      '--format',
      'text',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('AVAILABLE AMOUNT');
    expect(r.stdout).toContain('2614.13');
    expect(r.stdout).toContain('CNY');
  });

  it('invokes renderWithInk in default TUI mode', async () => {
    holder.services = makeMockServices({
      billingService: { getAvailableBalance: async () => balanceData },
    });
    const r = await runCommand(buildSummary, [
      'billing',
      'balance',
      'summary',
      '--format',
      'table',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// billing balance recharge command tests
// ────────────────────────────────────────────────────────────────────

describe('billing balance recharge', () => {
  const expectedUrl = 'https://platform.qianwenai.com/home/billing/overview?target=recharge';

  it('successfully opens browser with --format json', async () => {
    openBrowserSpy.mockImplementation(() => {});
    const r = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    const output = JSON.parse(r.stdout);
    expect(output.rechargeUrl).toBe(expectedUrl);
    expect(output.opened).toBe(true);
    expect(output.message).toBe('Recharge page opened in browser');
  });

  it('sets opened to false when browser open fails with --format json', async () => {
    openBrowserSpy.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const r = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    const output = JSON.parse(r.stdout);
    expect(output.rechargeUrl).toBe(expectedUrl);
    expect(output.opened).toBe(false);
    expect(output.message).toBe('Could not open browser automatically');
  });

  it('outputs recharge URL in text format', async () => {
    openBrowserSpy.mockImplementation(() => {});
    const r = await runCommand(buildRecharge, [
      'billing',
      'balance',
      'recharge',
      '--format',
      'text',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain(expectedUrl);
  });
});
