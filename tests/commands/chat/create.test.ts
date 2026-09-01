/**
 * Command-layer tests for `chat create`.
 *
 * These exercise the real Commander wiring through runCommand, substituting
 * only the service container boundary. Focus: flag surface, error exit codes,
 * non-streaming JSON envelope emission, streaming NDJSON emission, and the
 * command-level hiding of reasoning events unless --thinking is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { runCommand } from '../../helpers/run-command.js';
import type { ChatStreamEvent } from '../../../src/types/chat.js';

const holder: {
  create: ReturnType<typeof vi.fn>;
  streamEvents: ChatStreamEvent[];
  factory: ReturnType<typeof vi.fn>;
} = {
  create: vi.fn(),
  streamEvents: [],
  factory: vi.fn(),
};

vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated: () => ({}),
}));
vi.mock('../../../src/services/chat-runtime.js', () => ({
  createChatService: (options?: unknown) => {
    holder.factory(options);
    return {
      create: (input: unknown) => holder.create(input),
      createStream: () => {
        async function* gen(): AsyncIterable<ChatStreamEvent> {
          for (const e of holder.streamEvents) yield e;
        }
        return gen();
      },
    };
  },
}));

const { registerChatCommands } = await import('../../../src/commands/chat/index.js');

beforeEach(() => {
  holder.create = vi.fn().mockResolvedValue({ meta: {}, data: { choices: [] } });
  holder.streamEvents = [];
  holder.factory = vi.fn();
});

async function runStreaming(
  argv: string[],
): Promise<{ stdout: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as unknown as typeof process.stdout.write);
  try {
    const result = await runCommand((program) => registerChatCommands(program), argv);
    return { stdout: chunks.join(''), exitCode: result.exitCode };
  } finally {
    spy.mockRestore();
  }
}

describe('chat create — flag surface', () => {
  it('registers every tier 1/2/3 flag on the create command', () => {
    const program = new Command().name('qianwen');
    registerChatCommands(program);
    const chat = program.commands.find((c) => c.name() === 'chat')!;
    const create = chat.commands.find((c) => c.name() === 'create')!;
    const flags = create.options.map((o) => o.long);

    for (const flag of [
      '--model',
      '--temperature',
      '--max-tokens',
      '--stream',
      '--thinking',
      '--image',
      '--video',
      '--request',
      '--api-key',
    ]) {
      expect(flags).toContain(flag);
    }
  });

  it('forwards --api-key to the service factory as the apiKey option', async () => {
    await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--api-key', 'sk-cli', '--format', 'json'],
    );

    expect(holder.factory).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-cli' }));
  });

  it('does not set apiKey on the factory when --api-key is absent', async () => {
    await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'json'],
    );

    const arg = holder.factory.mock.calls[0]?.[0] as { apiKey?: unknown } | undefined;
    expect(arg?.apiKey).toBeUndefined();
  });
});

describe('chat create — argument validation exit codes', () => {
  it('exits 4 when neither prompt nor --request is given', async () => {
    holder.create = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('need input'), { code: 'INVALID_ARGUMENT', exitCode: 4 }),
      );

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
  });

  it('rejects a non-numeric --temperature with exit 4 before calling the service', async () => {
    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--temperature', 'abc', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
    expect(holder.create).not.toHaveBeenCalled();
  });

  it('rejects a non-positive --max-tokens with exit 4 before calling the service', async () => {
    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--max-tokens', '0', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
    expect(holder.create).not.toHaveBeenCalled();
  });

  it('rejects a fractional --max-tokens with exit 4', async () => {
    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--max-tokens', '1.5', '--format', 'json'],
    );

    expect(result.exitCode).toBe(4);
  });
});

describe('chat create — non-streaming output', () => {
  it('prints the success envelope as JSON', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: { request_id: 'r-1', usage: { input: 1, output: 2, total: 3 } },
      data: { id: 'r-1', choices: [{ message: { content: 'hi there' } }] },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'json'],
    );

    const payload = JSON.parse(result.stdout) as {
      meta: { request_id: string };
      data: { choices: unknown[] };
    };
    expect(payload.meta.request_id).toBe('r-1');
    expect(payload.data.choices).toHaveLength(1);
    expect(result.exitCode).toBeUndefined();
  });

  it('forwards parsed flags to the service', async () => {
    await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--temperature', '0.7', '--max-tokens', '256', '--format', 'json'],
    );

    const input = holder.create.mock.calls[0]![0] as {
      prompt: string;
      temperature: number;
      maxTokens: number;
    };
    expect(input.prompt).toBe('hi');
    expect(input.temperature).toBe(0.7);
    expect(input.maxTokens).toBe(256);
  });

  it('passes thinking undefined when neither --thinking nor --no-thinking is given', async () => {
    await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'json'],
    );

    const input = holder.create.mock.calls[0]![0] as { thinking?: boolean };
    expect(input.thinking).toBeUndefined();
  });

  it('passes thinking false for --no-thinking', async () => {
    await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--no-thinking', '--format', 'json'],
    );

    const input = holder.create.mock.calls[0]![0] as { thinking?: boolean };
    expect(input.thinking).toBe(false);
  });
});

describe('chat create — human-friendly (text) output', () => {
  it('prints only the assistant message for --format text, not the JSON envelope', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: {},
      data: { content: 'Hello! How can I help you today?' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'text'],
    );

    expect(result.stdout.trim()).toBe('Hello! How can I help you today?');
    expect(result.stdout).not.toContain('request_id');
    expect(result.stdout).not.toContain('"meta"');
  });

  it('appends a meta footer with model, tokens and request_id', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: {
        request_id: '09dceb20-ae2e-999b-85f9-abcdef',
        model: 'qwen3.7-max',
        usage: { input_tokens: 26, output_tokens: 512, total_tokens: 538 },
      },
      data: { content: 'answer', finish_reason: 'stop' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'text'],
    );

    expect(result.stdout).toContain('answer');
    expect(result.stdout).toContain('model qwen3.7-max');
    expect(result.stdout).toContain('tokens 26 in / 512 out / 538 total');
    expect(result.stdout).toContain('request_id 09dceb20-ae2e-999b-85f9-abcdef');
  });

  it('prints the request_id in full so it stays copy-pasteable', async () => {
    // Chat ids all share a constant `chatcmpl-` prefix; truncating to the first
    // few characters would leave nothing that identifies the request.
    holder.create = vi.fn().mockResolvedValue({
      meta: { request_id: 'chatcmpl-5bffcf64-4a0c-983e-b86f-d17511f6ced6' },
      data: { content: 'answer' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'text'],
    );

    expect(result.stdout).toContain('request_id chatcmpl-5bffcf64-4a0c-983e-b86f-d17511f6ced6');
    expect(result.stdout).not.toContain('…');
  });

  it('hides reasoning_content in text output by default', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: {},
      data: { content: 'answer', reasoning_content: 'secret thoughts' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'text'],
    );

    expect(result.stdout).toContain('answer');
    expect(result.stdout).not.toContain('secret thoughts');
  });

  it('reveals reasoning_content in text output when --thinking is set', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: {},
      data: { content: 'answer', reasoning_content: 'visible thoughts' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'text', '--thinking'],
    );

    expect(result.stdout).toContain('visible thoughts');
    expect(result.stdout).toContain('answer');
  });

  it('still prints the full envelope for --format json', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: { request_id: 'r-2' },
      data: { content: 'hi there' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'json'],
    );

    const payload = JSON.parse(result.stdout) as { meta: { request_id: string } };
    expect(payload.meta.request_id).toBe('r-2');
  });
});

describe('chat create — streaming NDJSON output', () => {
  function ndjsonRecords(stdout: string): unknown[] {
    return stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
  }

  it('writes incremental delta lines and a trailer meta line', async () => {
    holder.streamEvents = [
      { type: 'content', content: 'Hel', requestId: 'r-9', model: 'qwen3.7-max' },
      { type: 'content', content: 'lo' },
      { type: 'content', content: '', finishReason: 'stop' },
      { type: 'usage', usage: { input: 1, output: 2, total: 3 } },
      { type: 'done' },
    ];

    const result = await runStreaming(['chat', 'create', 'hi', '--stream', '--format', 'json']);

    const records = ndjsonRecords(result.stdout) as Array<Record<string, unknown>>;
    // Each line carries only the incremental text under `delta`.
    expect(records).toContainEqual({ delta: 'Hel' });
    expect(records).toContainEqual({ delta: 'lo' });
    const trailer = records[records.length - 1] as {
      meta: { usage: unknown; model: string; finish_reason: string; request_id: string };
    };
    expect(trailer.meta.request_id).toBe('r-9');
    expect(trailer.meta.model).toBe('qwen3.7-max');
    expect(trailer.meta.finish_reason).toBe('stop');
    expect(trailer.meta.usage).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    });
  });

  it('concatenating deltas in order reproduces the full answer', async () => {
    holder.streamEvents = [
      { type: 'content', content: '量子' },
      { type: 'content', content: '计算' },
      { type: 'content', content: '利用量子比特' },
      { type: 'done' },
    ];

    const result = await runStreaming(['chat', 'create', 'hi', '--stream', '--format', 'json']);

    const deltas = ndjsonRecords(result.stdout)
      .map((r) => (r as { delta?: string }).delta)
      .filter((d): d is string => typeof d === 'string');
    expect(deltas.join('')).toBe('量子计算利用量子比特');
  });

  it('emits no NDJSON envelope in text mode, just the incremental text', async () => {
    holder.streamEvents = [
      { type: 'content', content: 'Hello', model: 'qwen3.7-max', requestId: 'r-7' },
      { type: 'content', content: '! How can I help?' },
      { type: 'usage', usage: { input: 1, output: 2, total: 3 } },
      { type: 'done' },
    ];

    const result = await runStreaming(['chat', 'create', 'hi', '--stream', '--format', 'text']);

    expect(result.stdout).toContain('Hello! How can I help?');
    expect(result.stdout).not.toContain('"delta"');
    expect(result.stdout).toContain('model qwen3.7-max');
    expect(result.stdout).toContain('tokens 1 in / 2 out / 3 total');
  });

  it('hides reasoning events by default', async () => {
    holder.streamEvents = [
      { type: 'reasoning', reasoning: 'secret thoughts' },
      { type: 'content', content: 'answer' },
      { type: 'done' },
    ];

    const result = await runStreaming(['chat', 'create', 'hi', '--stream', '--format', 'json']);

    expect(result.stdout).not.toContain('secret thoughts');
    expect(result.stdout).toContain('answer');
  });

  it('reveals reasoning events when --thinking is set', async () => {
    holder.streamEvents = [
      { type: 'reasoning', reasoning: 'visible thoughts' },
      { type: 'content', content: 'answer' },
      { type: 'done' },
    ];

    const result = await runStreaming([
      'chat',
      'create',
      'hi',
      '--stream',
      '--thinking',
      '--format',
      'json',
    ]);

    expect(result.stdout).toContain('visible thoughts');
  });

  it('does not emit the usage event as a normal line, only via the trailer', async () => {
    holder.streamEvents = [
      { type: 'content', content: 'x' },
      { type: 'usage', usage: { input: 4, output: 5, total: 9 } },
      { type: 'done' },
    ];

    const result = await runStreaming(['chat', 'create', 'hi', '--stream', '--format', 'json']);

    const records = ndjsonRecords(result.stdout) as Array<Record<string, unknown>>;
    const usageLines = records.filter((r) => r.type === 'usage');
    expect(usageLines).toHaveLength(0);
    const trailer = records[records.length - 1] as { meta: { usage: unknown } };
    expect(trailer.meta.usage).toEqual({
      input_tokens: 4,
      output_tokens: 5,
      total_tokens: 9,
    });
  });

  it('surfaces a mid-stream error event with a non-zero exit code', async () => {
    holder.streamEvents = [
      { type: 'content', content: 'partial' },
      { type: 'error', error: { code: 'RateLimit', message: 'too many requests' } },
    ];

    const result = await runStreaming(['chat', 'create', 'hi', '--stream', '--format', 'json']);

    expect(result.exitCode).toBe(1);
  });
});

describe('chat create — empty content hint', () => {
  it('warns on stderr when non-streaming content is empty and finish_reason is length', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: {},
      data: { content: '', finish_reason: 'length' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'text'],
    );

    expect(result.stderr).toContain('--max-tokens');
    expect(result.stdout).not.toContain('--max-tokens');
    expect(result.exitCode).toBeUndefined();
  });

  it('warns on stderr when non-streaming content is empty and finish_reason is content_filter', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: {},
      data: { content: '', finish_reason: 'content_filter' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'text'],
    );

    expect(result.stderr).toContain('content filter');
    expect(result.exitCode).toBeUndefined();
  });

  it('does not warn when non-streaming content is empty but finish_reason is stop', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: {},
      data: { content: '', finish_reason: 'stop' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'text'],
    );

    expect(result.stderr).not.toContain('--max-tokens');
  });

  it('emits no hint on stderr for JSON output even when content is empty', async () => {
    holder.create = vi.fn().mockResolvedValue({
      meta: {},
      data: { content: '', finish_reason: 'length' },
    });

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'json'],
    );

    expect(result.stderr).toBe('');
  });

  it('warns on stderr when streaming yields no content and finish_reason is length', async () => {
    holder.streamEvents = [
      { type: 'reasoning', reasoning: 'thinking hard' },
      { type: 'content', content: '', finishReason: 'length' },
      { type: 'done' },
    ];

    const result = await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--stream', '--format', 'text'],
    );

    expect(result.stderr).toContain('--max-tokens');
  });
});

describe('chat create — TTY streaming default', () => {
  const originalIsTTY = process.stdout.isTTY;

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('streams by default on an interactive terminal', async () => {
    setTTY(true);
    holder.streamEvents = [
      { type: 'content', content: 'hello' },
      { type: 'done' },
    ];

    const result = await runStreaming(['chat', 'create', 'hi', '--format', 'text']);

    expect(result.stdout).toContain('hello');
    expect(holder.create).not.toHaveBeenCalled();
  });

  it('does not stream by default when stdout is not a terminal', async () => {
    setTTY(false);

    await runCommand(
      (program) => registerChatCommands(program),
      ['chat', 'create', 'hi', '--format', 'json'],
    );

    expect(holder.create).toHaveBeenCalledTimes(1);
  });

  it('streams when --stream is explicit even without a terminal', async () => {
    setTTY(false);
    holder.streamEvents = [
      { type: 'content', content: 'forced' },
      { type: 'done' },
    ];

    const result = await runStreaming(['chat', 'create', 'hi', '--stream', '--format', 'text']);

    expect(result.stdout).toContain('forced');
    expect(holder.create).not.toHaveBeenCalled();
  });
});
