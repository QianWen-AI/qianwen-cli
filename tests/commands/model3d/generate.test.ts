/**
 * Command-layer tests for `model3d generate`.
 *
 * Real Commander wiring through runCommand, substituting only the service
 * factory boundary. Focus: flag surface, argument forwarding, exit codes and
 * JSON envelope emission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { runCommand } from '../../helpers/run-command.js';

const holder: { generate: ReturnType<typeof vi.fn> } = {
  generate: vi.fn(),
};

vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => ({}),
}));
vi.mock('../../../src/services/model3d-runtime.js', () => ({
  createModel3dService: () => ({
    generate: (input: unknown) => holder.generate(input),
  }),
}));

const { registerModel3dCommands } = await import('../../../src/commands/model3d/index.js');

function okOutcome(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { envelope: { meta: {}, data }, completed: true };
}

beforeEach(() => {
  holder.generate = vi.fn().mockResolvedValue(okOutcome({ task_status: 'SUCCEEDED', urls: [] }));
});

describe('model3d generate — flag surface', () => {
  it('registers every tier 1/2/3 and run-control flag', () => {
    const program = new Command().name('qianwen');
    registerModel3dCommands(program);
    const group = program.commands.find((c) => c.name() === 'model3d')!;
    const generate = group.commands.find((c) => c.name() === 'generate')!;
    const flags = generate.options.map((o) => o.long);

    for (const flag of [
      '--model',
      '--image',
      '--texture-quality',
      '--wait',
      '--no-wait',
      '--timeout',
      '--out',
      '--request',
      '--format',
      '--api-key',
    ]) {
      expect(flags).toContain(flag);
    }
  });
});

describe('model3d generate — argument forwarding', () => {
  it('forwards the prompt and tier flags into the service input', async () => {
    await runCommand(
      (program) => registerModel3dCommands(program),
      [
        'model3d',
        'generate',
        '一把木质椅子',
        '--model',
        'Tripo/Tripo-P1.0',
        '--texture-quality',
        'detailed',
        '--format',
        'json',
      ],
    );

    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.prompt).toBe('一把木质椅子');
    expect(input.model).toBe('Tripo/Tripo-P1.0');
    expect(input.textureQuality).toBe('detailed');
  });

  it('forwards --image and --no-wait', async () => {
    await runCommand(
      (program) => registerModel3dCommands(program),
      ['model3d', 'generate', '--image', 'chair.png', '--no-wait', '--format', 'json'],
    );
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.image).toBe('chair.png');
    expect(input.wait).toBe(false);
  });
});

describe('model3d generate — output and exit codes', () => {
  it('prints the success envelope as JSON', async () => {
    const result = await runCommand(
      (program) => registerModel3dCommands(program),
      ['model3d', 'generate', 'chair', '--format', 'json'],
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.task_status).toBe('SUCCEEDED');
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('renders --no-wait as a successful submitted task, not a completed model', async () => {
    holder.generate = vi.fn().mockResolvedValue({
      envelope: {
        meta: { model: 'Tripo/Tripo-P1.0' },
        data: { task_status: 'PENDING', task_id: 'm3-submit' },
      },
      completed: false,
    });

    const result = await runCommand(
      (program) => registerModel3dCommands(program),
      ['model3d', 'generate', 'chair', '--no-wait', '--format', 'text'],
    );

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toContain('已提交 3D 生成任务');
    expect(result.stdout).toContain('task_id m3-submit · status PENDING');
    expect(result.stdout).not.toContain('3D 模型生成完成');
  });

  it('exits 8 when the task did not complete before the timeout', async () => {
    holder.generate = vi.fn().mockResolvedValue({
      envelope: { meta: {}, data: { task_status: 'running', task_id: 'm3-x' } },
      completed: false,
    });

    const result = await runCommand(
      (program) => registerModel3dCommands(program),
      ['model3d', 'generate', 'chair', '--format', 'json'],
    );

    expect(result.exitCode).toBe(8);
    expect(JSON.parse(result.stdout).data.task_id).toBe('m3-x');
  });

  it('exits 4 when the service raises the site-not-available guard', async () => {
    holder.generate = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('not available'), { code: 'INVALID_ARGUMENT', exitCode: 4 }),
      );

    const result = await runCommand(
      (program) => registerModel3dCommands(program),
      ['model3d', 'generate', 'chair', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
  });

  it('coerces --timeout seconds into milliseconds', async () => {
    await runCommand(
      (program) => registerModel3dCommands(program),
      ['model3d', 'generate', 'chair', '--timeout', '30', '--format', 'json'],
    );
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.timeoutMs).toBe(30000);
  });
});
