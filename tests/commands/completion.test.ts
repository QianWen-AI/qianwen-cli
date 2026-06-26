/**
 * Focused tests for `completion install --shell fish` filesystem safety:
 *   - the parent config dir (~/.config/fish) is created before the rc append
 *     so a fresh setup does not fail with ENOENT
 *   - a write failure is reported gracefully (exit 1, no stack trace)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCommand } from '../helpers/run-command.js';

// ── Module mocks ────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    homedir: vi.fn(() => '/mock-home'),
  };
});

const { existsSync, readFileSync, appendFileSync, mkdirSync } = await import('fs');
const { registerCompletionCommand } = await import('../../src/commands/completion.js');

// ── Helpers ─────────────────────────────────────────────────────────────

function setupCompletion(program: import('commander').Command) {
  registerCompletionCommand(program);
}

async function generateScript(shell: string): Promise<string> {
  const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const r = await runCommand(setupCompletion, ['completion', 'generate', '--shell', shell]);
    expect(r.exitCode).toBeUndefined();
    return stdoutWriteSpy.mock.calls.map((c) => String(c[0])).join('');
  } finally {
    stdoutWriteSpy.mockRestore();
  }
}

let originalShell: string | undefined;

beforeEach(() => {
  originalShell = process.env.SHELL;
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(readFileSync).mockReturnValue('');
  vi.mocked(appendFileSync).mockReset();
  vi.mocked(mkdirSync).mockClear();
});

afterEach(() => {
  if (originalShell !== undefined) {
    process.env.SHELL = originalShell;
  } else {
    delete process.env.SHELL;
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('completion install — fish rc filesystem safety', () => {
  it('creates the fish config directory before writing so a fresh setup does not ENOENT', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const r = await runCommand(setupCompletion, ['completion', 'install', '--shell', 'fish']);

    expect(r.exitCode).toBeUndefined();
    expect(mkdirSync).toHaveBeenCalledWith('/mock-home/.config/fish', { recursive: true });
    const mkdirOrder = vi.mocked(mkdirSync).mock.invocationCallOrder[0];
    const appendOrder = vi.mocked(appendFileSync).mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(appendOrder);
  });

  it('reports a graceful error (no stack trace) when the rc write fails', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const r = await runCommand(setupCompletion, ['completion', 'install', '--shell', 'fish']);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/failed to write completion config/i);
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });
});

