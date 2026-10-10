/**
 * Focused tests for `completion install --shell fish` filesystem safety:
 *   - the parent config dir (~/.config/fish) is created before the rc append
 *     so a fresh setup does not fail with ENOENT
 *   - a write failure is reported gracefully (exit 1, no stack trace)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
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
    // The production path is join(homedir(), '.config', 'fish'), whose
    // separator is platform-dependent; build the expectation the same way.
    expect(mkdirSync).toHaveBeenCalledWith(join('/mock-home', '.config', 'fish'), {
      recursive: true,
    });
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

  it('appends a completion block that ends with a newline so a later append starts on its own line', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await runCommand(setupCompletion, ['completion', 'install', '--shell', 'zsh']);

    const written = vi.mocked(appendFileSync).mock.calls[0]?.[1] as string;
    expect(written).toMatch(/\n$/);
  });
});

describe('completion generate — recharge command definitions', () => {
  it.each(['bash', 'zsh', 'fish'])(
    '%s script includes public recharge commands and options',
    async (shell) => {
      const script = await generateScript(shell);
      const compact = script.replace(/\s+/gu, ' ');

      expect(script).toContain('recharge-history');
      if (shell === 'zsh') {
        expect(compact).toContain(
          "recharge) _arguments '--channel[Payment channel]:channel:(alipay)' '--amount[CNY amount]:amount:()'",
        );
        expect(compact).toContain(
          "recharge-history) _arguments '--range[Shanghai day range]:range:(1d 3d 7d 30d)' '--start-time[Start time]:time:()' '--end-time[End time]:time:()'",
        );
      } else if (shell === 'bash') {
        expect(compact).toContain(
          'recharge) COMPREPLY=( $(compgen -W "--channel --amount --format -h --help"',
        );
        expect(compact).toContain(
          'recharge-history) COMPREPLY=( $(compgen -W "--range --start-time --end-time --page --page-size --format -h --help"',
        );
        expect(compact).toContain('--range) COMPREPLY=( $(compgen -W "1d 3d 7d 30d"');
      } else {
        expect(compact).toContain(
          "_seen_path billing balance recharge' -l channel -d 'Payment channel' -a 'alipay'",
        );
        expect(compact).toContain(
          "_seen_path billing balance recharge-history' -l range -d 'Shanghai day range' -a '1d 3d 7d 30d'",
        );
        expect(compact).toContain(
          "_seen_path billing balance recharge-history' -l start-time -d 'Start time'",
        );
      }
      expect(script).not.toContain('--method');
      expect(script).not.toMatch(/recharge[^\n]*\bresult\b/);
    },
  );
});

describe('completion generate — hidden Token Plan agent options', () => {
  const agentOptions = [
    '--preview',
    '--confirm',
    '--coupon',
    '--no-coupon',
    '--preview-amount',
    '--balance-deduction',
  ];

  it.each(['bash', 'zsh', 'fish'])(
    '%s offers team seat options and omits Agent-only options',
    async (shell) => {
      const script = await generateScript(shell);
      for (const tier of ['standard', 'pro', 'max']) {
        expect(script).toContain(`${tier}-seat-count`);
      }
      if (shell !== 'bash') {
        expect(script).toContain('Number of Pro Seats');
        expect(script).toContain('Number of Max Seats');
      }
      for (const option of agentOptions) expect(script).not.toContain(option);
    },
  );
});

describe('completion generate — Token Plan seat spec values', () => {
  it.each(['bash', 'zsh', 'fish'])('%s offers all three seat specs', async (shell) => {
    const script = await generateScript(shell);
    if (shell === 'bash') {
      expect(script).toMatch(/--spec-type\)\s+COMPREPLY=\( \$\(compgen -W "standard pro max"/);
    } else if (shell === 'zsh') {
      expect(script).toContain('--spec-type)   compadd standard pro max;');
      expect(script).toContain('--spec-type[Seat spec]:type:(standard pro max)');
    } else {
      expect(script).toContain("-l spec-type -d 'Seat spec' -a 'standard pro max'");
    }
  });
});
