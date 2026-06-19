import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';
import type { ServiceContainer } from '../../../src/services/index.js';
import type { WorkspaceLimitResult } from '../../../src/types/workspace.js';
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

const { workspaceLimitAction } = await import('../../../src/commands/workspace/limit.js');

function build(program: import('commander').Command) {
  const ws = program.command('workspace');
  const limit = ws.command('limit').option('--format <fmt>');
  limit.action(workspaceLimitAction(limit));
}

beforeEach(() => {
  holder.services = makeMockServices();
  renderWithInkSpy.mockReset();
  renderWithInkSpy.mockImplementation(renderInkForTest);
  clearRenderedFrames();
});

const sample: WorkspaceLimitResult = { current: 2, max: 5 };

describe('workspace limit command', () => {
  it('JSON returns the {current, max} envelope', async () => {
    holder.services = makeMockServices({
      workspaceService: { limit: async () => sample },
    });
    const r = await runCommand(build, ['workspace', 'limit', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.stdout)).toEqual({ current: 2, max: 5 });
  });

  it('text mode renders without throwing', async () => {
    holder.services = makeMockServices({
      workspaceService: { limit: async () => sample },
    });
    const r = await runCommand(build, ['workspace', 'limit', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
  });

  it('table mode invokes renderWithInk', async () => {
    holder.services = makeMockServices({
      workspaceService: { limit: async () => sample },
    });
    const r = await runCommand(build, ['workspace', 'limit', '--format', 'table']);
    expect(r.exitCode).toBeUndefined();
    expect(renderWithInkSpy).toHaveBeenCalledTimes(1);
  });

  it('upstream rejection produces handleError exit', async () => {
    holder.services = makeMockServices({
      workspaceService: {
        limit: async () => {
          throw new Error('upstream-down');
        },
      },
    });
    const r = await runCommand(build, ['workspace', 'limit', '--format', 'json']);
    expect(r.exitCode).toBeGreaterThan(0);
  });
});
