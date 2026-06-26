import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { SupportTicketListResult } from '../../../src/types/support.js';
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

import { supportListAction } from '../../../src/commands/support/list.js';

function build(program: import('commander').Command) {
  const support = program.command('support');
  support
    .command('list')
    .option('--page <n>', 'page', '1')
    .option('--page-size <n>', 'ps', '10')
    .option('--format <fmt>')
    .action(async function (this: import('commander').Command, opts: Record<string, unknown>) {
      // The root program also declares --format, so commander attributes the
      // flag to whichever command's parser sees it first. Walk up to recover.
      const merged: Record<string, unknown> = { ...opts };
      let cmd: import('commander').Command | null = this;
      while (cmd && merged.format === undefined) {
        const parentOpts = cmd.opts();
        if (parentOpts.format) merged.format = parentOpts.format;
        cmd = cmd.parent;
      }
      await supportListAction(merged);
    });
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

const sample: SupportTicketListResult = {
  tickets: [
    { id: 't1', title: 'Cannot login', status: 'open', createdAt: 1717200000000 },
    { id: 't2', title: 'Billing question', status: 'closed', createdAt: 1717100000000 },
  ],
  total: 2,
  page: 1,
  pageSize: 10,
};

describe('support list command', () => {
  it('JSON returns tickets/total/page/pageSize', async () => {
    holder.services = makeMockServices({
      supportService: { listTickets: async () => sample },
    });
    const r = await runCommand(build, ['support', 'list', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.tickets).toHaveLength(2);
    expect(payload.total).toBe(2);
  });

  it('table mode prints empty message when no tickets', async () => {
    holder.services = makeMockServices({
      supportService: {
        listTickets: async () => ({ tickets: [], total: 0, page: 1, pageSize: 10 }),
      },
    });
    const r = await runCommand(build, ['support', 'list', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    // empty message text from view-model
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('text mode renders without throwing', async () => {
    holder.services = makeMockServices({
      supportService: { listTickets: async () => sample },
    });
    const r = await runCommand(build, ['support', 'list', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
  });

  it('table mode invokes renderInteractive for non-empty list in TTY', async () => {
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    try {
      holder.services = makeMockServices({
        supportService: { listTickets: async () => sample },
      });
      const r = await runCommand(build, ['support', 'list', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
    }
  });

  it('table mode falls back to text when not TTY', async () => {
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, writable: true });
    try {
      holder.services = makeMockServices({
        supportService: { listTickets: async () => sample },
      });
      const r = await runCommand(build, ['support', 'list', '--format', 'table']);
      expect(r.exitCode).toBeUndefined();
      expect(renderWithInkSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
    }
  });

  it('passes page/pageSize to the service', async () => {
    const calls: Array<{ page?: number; pageSize?: number }> = [];
    holder.services = makeMockServices({
      supportService: {
        listTickets: async (opts: { page?: number; pageSize?: number }) => {
          calls.push(opts);
          return sample;
        },
      },
    });
    const r = await runCommand(build, [
      'support',
      'list',
      '--page',
      '3',
      '--page-size',
      '5',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(calls[0]).toMatchObject({ page: 3, pageSize: 5 });
  });

  it('rejects --page-size exceeding 10', async () => {
    holder.services = makeMockServices({
      supportService: { listTickets: async () => sample },
    });
    const r = await runCommand(build, [
      'support',
      'list',
      '--page-size',
      '50',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeGreaterThan(0);
    expect(r.stderr).toContain('positive integer between 1 and 10');
  });

  it('rejects non-integer --page-size', async () => {
    holder.services = makeMockServices({
      supportService: { listTickets: async () => sample },
    });
    const r = await runCommand(build, [
      'support',
      'list',
      '--page-size',
      'abc',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeGreaterThan(0);
    expect(r.stderr).toContain('positive integer between 1 and 10');
  });

  it('rejects --page-size of 0', async () => {
    holder.services = makeMockServices({
      supportService: { listTickets: async () => sample },
    });
    const r = await runCommand(build, [
      'support',
      'list',
      '--page-size',
      '0',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBeGreaterThan(0);
    expect(r.stderr).toContain('positive integer between 1 and 10');
  });
});
