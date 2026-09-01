/**
 * Command-layer tests for `image generate`.
 *
 * These exercise the real Commander wiring through runCommand, substituting
 * only the service factory boundary. Focus: flag surface, argument validation
 * exit codes, flag forwarding, and JSON envelope emission.
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
vi.mock('../../../src/services/image-runtime.js', () => ({
  createImageService: () => ({
    generate: (input: unknown) => holder.generate(input),
  }),
}));

const { registerImageCommands } = await import('../../../src/commands/image/index.js');

beforeEach(() => {
  holder.generate = vi.fn().mockResolvedValue({ meta: {}, data: { artifacts: [] } });
});

describe('image generate — flag surface', () => {
  it('registers every tier 1/2/3 flag on the generate command', () => {
    const program = new Command().name('qianwen');
    registerImageCommands(program);
    const image = program.commands.find((c) => c.name() === 'image')!;
    const generate = image.commands.find((c) => c.name() === 'generate')!;
    const flags = generate.options.map((o) => o.long);

    for (const flag of [
      '--model',
      '--size',
      '--n',
      '--image',
      '--out',
      '--response-format',
      '--request',
      '--timeout',
      '--api-key',
    ]) {
      expect(flags).toContain(flag);
    }
  });
});

describe('image generate — argument validation exit codes', () => {
  it('exits 4 when neither prompt nor --request is given', async () => {
    holder.generate = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('need input'), { code: 'INVALID_ARGUMENT', exitCode: 4 }),
      );

    const result = await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
  });

  it('rejects a non-numeric --n with exit 4 before calling the service', async () => {
    const result = await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'x', '--n', 'abc', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
    expect(holder.generate).not.toHaveBeenCalled();
  });

  it('rejects a non-positive --n with exit 4 before calling the service', async () => {
    const result = await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'x', '--n', '0', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
    expect(holder.generate).not.toHaveBeenCalled();
  });

  it('rejects a fractional --n with exit 4', async () => {
    const result = await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'x', '--n', '1.5', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
  });

  it('rejects a non-positive --timeout with exit 4 before calling the service', async () => {
    const result = await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'x', '--timeout', '0', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
    expect(holder.generate).not.toHaveBeenCalled();
  });

  it('propagates a service-level validation error exit code', async () => {
    holder.generate = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('conflict'), { code: 'INVALID_ARGUMENT', exitCode: 4 }),
      );

    const result = await runCommand(
      (program) => registerImageCommands(program),
      [
        'image',
        'generate',
        'x',
        '--size',
        '2*2',
        '--request',
        '{"parameters":{"size":"1*1"}}',
        '--format',
        'json',
      ],
    );

    expect(result.exitCode).toBe(4);
  });
});

describe('image generate — flag forwarding', () => {
  it('forwards parsed flags to the service', async () => {
    await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'a city', '--size', '1024*1024', '--n', '3', '--format', 'json'],
    );

    const input = holder.generate.mock.calls[0]![0] as {
      prompt: string;
      size: string;
      n: number;
    };
    expect(input.prompt).toBe('a city');
    expect(input.size).toBe('1024*1024');
    expect(input.n).toBe(3);
  });

  it('forwards --timeout as milliseconds into the service input', async () => {
    await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'a city', '--timeout', '120', '--format', 'json'],
    );

    const input = holder.generate.mock.calls[0]![0] as { timeoutMs?: number };
    expect(input.timeoutMs).toBe(120000);
  });

  it('forwards --image, --out and --response-format to the service', async () => {
    await runCommand(
      (program) => registerImageCommands(program),
      [
        'image',
        'generate',
        'edit it',
        '--image',
        './src.png',
        '--out',
        'pics/',
        '--response-format',
        'b64',
        '--format',
        'json',
      ],
    );

    const input = holder.generate.mock.calls[0]![0] as {
      image: string;
      out: string;
      responseFormat: string;
    };
    expect(input.image).toBe('./src.png');
    expect(input.out).toBe('pics/');
    expect(input.responseFormat).toBe('b64');
  });

  it('omits optional flags from the service input when they are not provided', async () => {
    await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'x', '--format', 'json'],
    );

    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect('size' in input).toBe(false);
    expect('n' in input).toBe(false);
    expect('image' in input).toBe(false);
    expect('out' in input).toBe(false);
    expect('responseFormat' in input).toBe(false);
  });
});

describe('image generate — non-streaming output', () => {
  it('prints the success envelope as JSON', async () => {
    holder.generate = vi.fn().mockResolvedValue({
      meta: { request_id: 'r-1' },
      data: {
        images: [{ index: 1, url: 'https://mock-api.test.qianwenai.com/a.png', path: 'a.png' }],
      },
    });

    const result = await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'x', '--format', 'json'],
    );

    const payload = JSON.parse(result.stdout) as {
      meta: { request_id: string };
      data: { images: unknown[] };
    };
    expect(payload.meta.request_id).toBe('r-1');
    expect(payload.data.images).toHaveLength(1);
    expect(result.exitCode).toBeUndefined();
  });

  it('renders the submitted view for an async model returned with --no-wait', async () => {
    holder.generate = vi.fn().mockResolvedValue({
      meta: { request_id: 'r-2' },
      data: { task_id: 'img-task-9', task_status: 'PENDING' },
    });

    const result = await runCommand(
      (program) => registerImageCommands(program),
      ['image', 'generate', 'x', '--no-wait', '--format', 'text'],
    );

    expect(result.stdout).toContain('已提交图片生成任务');
    expect(result.stdout).toContain('task_id img-task-9 · status PENDING');
    expect(result.stdout).toContain('`qianwen task get img-task-9` 查询进度');
    expect(result.exitCode).toBeUndefined();
  });
});
