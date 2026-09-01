/**
 * Command-layer tests for `music generate`.
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
vi.mock('../../../src/services/music-runtime.js', () => ({
  createMusicService: () => ({
    generate: (input: unknown) => holder.generate(input),
  }),
}));

const { registerMusicCommands } = await import('../../../src/commands/music/index.js');

function okEnvelope(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { meta: {}, data };
}

beforeEach(() => {
  holder.generate = vi
    .fn()
    .mockResolvedValue(okEnvelope({ output: { audio: { url: 'u' } }, artifacts: [{ url: 'u' }] }));
});

describe('music generate — flag surface', () => {
  it('registers every tier 1/2/3 flag', () => {
    const program = new Command().name('qianwen');
    registerMusicCommands(program);
    const group = program.commands.find((c) => c.name() === 'music')!;
    const generate = group.commands.find((c) => c.name() === 'generate')!;
    const flags = generate.options.map((o) => o.long);

    for (const flag of ['--model', '--out', '--request', '--format', '--api-key']) {
      expect(flags).toContain(flag);
    }
  });

  it('exposes --timeout (synchronous Fun-Music) but no async task flags', () => {
    const program = new Command().name('qianwen');
    registerMusicCommands(program);
    const group = program.commands.find((c) => c.name() === 'music')!;
    const generate = group.commands.find((c) => c.name() === 'generate')!;
    const flags = generate.options.map((o) => o.long);

    expect(flags).toContain('--timeout');
    expect(flags).not.toContain('--wait');
    expect(flags).not.toContain('--no-wait');
  });

  it('exposes --no-stream to opt out of SSE streaming', () => {
    const program = new Command().name('qianwen');
    registerMusicCommands(program);
    const group = program.commands.find((c) => c.name() === 'music')!;
    const generate = group.commands.find((c) => c.name() === 'generate')!;
    const flags = generate.options.map((o) => o.long);

    expect(flags).toContain('--no-stream');
  });
});

describe('music generate — argument forwarding', () => {
  it('forwards the prompt and tier flags into the service input', async () => {
    await runCommand(
      (program) => registerMusicCommands(program),
      [
        'music',
        'generate',
        '轻快的钢琴曲',
        '--model',
        'fun-music-v1',
        '--out',
        'travel.mp3',
        '--format',
        'json',
      ],
    );

    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.prompt).toBe('轻快的钢琴曲');
    expect(input.model).toBe('fun-music-v1');
    expect(input.out).toBe('travel.mp3');
  });

  it('forwards --request passthrough', async () => {
    await runCommand(
      (program) => registerMusicCommands(program),
      [
        'music',
        'generate',
        '--request',
        '{"model":"fun-music-v1","input":{"lyrics":"[verse]x"}}',
        '--format',
        'json',
      ],
    );
    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.request).toBe('{"model":"fun-music-v1","input":{"lyrics":"[verse]x"}}');
  });

  it('forwards --timeout as milliseconds into the service input', async () => {
    await runCommand(
      (program) => registerMusicCommands(program),
      ['music', 'generate', 'tune', '--timeout', '30', '--format', 'json'],
    );

    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.timeoutMs).toBe(30000);
  });

  it('streams by default (no stream flag in the service input)', async () => {
    await runCommand(
      (program) => registerMusicCommands(program),
      ['music', 'generate', 'tune', '--format', 'json'],
    );

    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.stream).toBeUndefined();
  });

  it('forwards --no-stream as stream=false', async () => {
    await runCommand(
      (program) => registerMusicCommands(program),
      ['music', 'generate', 'tune', '--no-stream', '--format', 'json'],
    );

    const input = holder.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.stream).toBe(false);
  });
});

describe('music generate — output and exit codes', () => {
  it('prints the success envelope as JSON', async () => {
    const result = await runCommand(
      (program) => registerMusicCommands(program),
      ['music', 'generate', 'tune', '--format', 'json'],
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.artifacts[0].url).toBe('u');
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('exits 4 when the service raises the site-not-available guard', async () => {
    holder.generate = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('not available'), { code: 'INVALID_ARGUMENT', exitCode: 4 }),
      );

    const result = await runCommand(
      (program) => registerMusicCommands(program),
      ['music', 'generate', 'tune', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
  });
});

describe('music generate — command group help', () => {
  it('registers the music command with a generate subcommand', () => {
    const program = new Command().name('qianwen');
    registerMusicCommands(program);
    const group = program.commands.find((c) => c.name() === 'music')!;
    expect(group.commands.map((c) => c.name())).toContain('generate');
  });
});
