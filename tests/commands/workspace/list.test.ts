import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { WorkspaceListResult } from '../../../src/types/workspace.js';
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

import { workspaceListAction } from '../../../src/commands/workspace/list.js';

function build(program: import('commander').Command) {
  const ws = program.command('workspace');
  const list = ws.command('list').option('--format <fmt>');
  list.action(workspaceListAction(list));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

const sample: WorkspaceListResult = {
  items: [
    {
      id: 'ws-1',
      name: 'default',
      region: 'cn-hangzhou',
      createdAt: '2026-01-01',
      isDefault: true,
      tenantId: 0,
    },
  ],
  total: 1,
  limit: 5,
};

describe('workspace list command', () => {
  it('JSON returns items + total + limit', async () => {
    holder.services = makeMockServices({
      workspaceService: { list: async () => sample },
    });
    const r = await runCommand(build, ['workspace', 'list', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.items).toHaveLength(1);
    expect(payload.total).toBe(1);
    expect(payload.limit).toBe(5);
  });

  it('table mode prints "No workspaces found" when empty', async () => {
    holder.services = makeMockServices({
      workspaceService: {
        list: async () => ({ items: [], total: 0, limit: 5 }),
      },
    });
    const r = await runCommand(build, ['workspace', 'list', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('No workspaces found');
  });

  it('text mode renders without throwing', async () => {
    holder.services = makeMockServices({
      workspaceService: { list: async () => sample },
    });
    const r = await runCommand(build, ['workspace', 'list', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
  });

  it('table mode invokes renderWithInk for non-empty list', async () => {
    holder.services = makeMockServices({
      workspaceService: { list: async () => sample },
    });
    const r = await runCommand(build, ['workspace', 'list', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });
});
