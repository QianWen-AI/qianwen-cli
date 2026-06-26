import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { SupportTicketDetail, SupportMessagesResult } from '../../../src/types/support.js';
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
vi.mock('../../../src/ui/SupportView.js', () => ({
  renderSupportViewInk: renderWithInkSpy,
}));

import { supportViewAction } from '../../../src/commands/support/view.js';

function build(program: import('commander').Command) {
  const support = program.command('support');
  support
    .command('view')
    .argument('<ticketId>')
    .option('--format <fmt>')
    .action(async function (
      this: import('commander').Command,
      ticketId: string,
      opts: Record<string, unknown>,
    ) {
      const merged: Record<string, unknown> = { ...opts };
      let cmd: import('commander').Command | null = this;
      while (cmd && merged.format === undefined) {
        const parentOpts = cmd.opts();
        if (parentOpts.format) merged.format = parentOpts.format;
        cmd = cmd.parent;
      }
      await supportViewAction(ticketId, merged);
    });
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

const sampleDetail: SupportTicketDetail = {
  id: 't1',
  title: 'Cannot login',
  status: 'open',
  createdAt: 1717200000000,
  category: 'Auth/Login',
  description: 'Login fails with 401.',
};

const sampleMessages: SupportMessagesResult = {
  messages: [
    { role: 'user', nickName: 'Alice', content: 'Need help', createdAt: 1717200001000 },
    { role: 'engineer', nickName: 'Bob', content: 'Looking into it', createdAt: 1717200002000 },
  ],
  truncated: false,
};

describe('support view command', () => {
  it('JSON returns ticket + messages + truncated', async () => {
    holder.services = makeMockServices({
      supportService: {
        getTicketDetail: async () => ({ detail: sampleDetail, messages: sampleMessages }),
      },
    });
    const r = await runCommand(build, ['support', 'view', 't1', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.ticket.id).toBe('t1');
    expect(payload.messages).toHaveLength(2);
    expect(payload.truncated).toBe(false);
  });

  it('text mode renders without throwing', async () => {
    holder.services = makeMockServices({
      supportService: {
        getTicketDetail: async () => ({ detail: sampleDetail, messages: sampleMessages }),
      },
    });
    const r = await runCommand(build, ['support', 'view', 't1', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
  });

  it('table mode invokes renderSupportViewInk', async () => {
    holder.services = makeMockServices({
      supportService: {
        getTicketDetail: async () => ({ detail: sampleDetail, messages: sampleMessages }),
      },
    });
    const r = await runCommand(build, ['support', 'view', 't1', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });

  it('passes the ticketId to the service', async () => {
    const calls: string[] = [];
    holder.services = makeMockServices({
      supportService: {
        getTicketDetail: async (id: string) => {
          calls.push(id);
          return { detail: sampleDetail, messages: sampleMessages };
        },
      },
    });
    const r = await runCommand(build, ['support', 'view', 'ticket-42', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(calls[0]).toBe('ticket-42');
  });
});
