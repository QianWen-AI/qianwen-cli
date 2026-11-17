import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenApiCallOptions } from '../../../src/types/openapi.js';
import { runCommand } from '../../helpers/run-command.js';
import { makeMockServices } from '../../helpers/service-container-mock.js';

const { call, createServices, ensureAuthenticated, renderApiCallInk, config, runtime } = vi.hoisted(
  () => ({
    call: vi.fn<(options: OpenApiCallOptions) => Promise<unknown>>(),
    createServices: vi.fn(),
    ensureAuthenticated: vi.fn(() => ({ access_token: 'synthetic-openapi-credential' })),
    renderApiCallInk: vi.fn<() => Promise<void>>(),
    config: { value: { 'output.format': 'auto' } },
    runtime: { repl: false },
  }),
);

vi.mock('../../../src/services/index.js', () => ({ createServices }));
vi.mock('../../../src/config/manager.js', () => ({ getEffectiveConfig: () => config.value }));
vi.mock('../../../src/auth/credentials.js', () => ({
  ensureAuthenticated,
  resolveCredentials: vi.fn(() => null),
  getCredentials: vi.fn(() => null),
}));
vi.mock('../../../src/ui/ApiCallTable.js', () => ({ renderApiCallInk }));
vi.mock('../../../src/ui/spinner.js', () => ({
  withSpinner: async (_label: string, run: () => Promise<unknown>) => run(),
  clearSpinnerLine: () => undefined,
}));
vi.mock('../../../src/utils/runtime-mode.js', () => ({
  isReplMode: () => runtime.repl,
  loginCommand: () => (runtime.repl ? 'login' : 'qianwen login'),
  formatCmd: (command: string) => (runtime.repl ? command : `qianwen ${command}`),
}));

import { registerApiCommands } from '../../../src/commands/api/index.js';
import { buildApiCallViewModel } from '../../../src/view-models/api-call.js';
import { CliError } from '../../../src/utils/errors.js';
import { interruptActiveCommand } from '../../../src/utils/command-interrupt.js';

const valid = ['--product', 'AliyunDeliveryService', '--action', 'ListModelSeries'];
const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
let listenersBefore: ReturnType<typeof process.listeners>;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  call.mockReset().mockResolvedValue({ models: [], total: 0 });
  createServices.mockReturnValue(makeMockServices({ openApiService: { call } }));
  renderApiCallInk.mockReset().mockResolvedValue(undefined);
  config.value = { 'output.format': 'auto' };
  runtime.repl = false;
  listenersBefore = process.listeners('SIGINT');
  previousExitCode = process.exitCode;
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
});

afterEach(() => {
  interruptActiveCommand();
  for (const listener of process.listeners('SIGINT')) {
    if (!listenersBefore.includes(listener)) process.removeListener('SIGINT', listener);
  }
  for (const [stream, descriptor] of [
    [process.stdin, stdinDescriptor],
    [process.stdout, stdoutDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

function invoke(args = valid, format: string | undefined = 'json') {
  return runCommand(registerApiCommands, [
    'api',
    'call',
    ...args,
    ...(format ? ['--format', format] : []),
  ]);
}

describe('api call arguments and command interface', () => {
  it('registers api/call with limited options and no routing, credential or file-input overrides', () => {
    const program = new Command().name('qianwen');
    registerApiCommands(program);
    const api = program.commands.find((command) => command.name() === 'api');
    const command = api?.commands.find((candidate) => candidate.name() === 'call');
    expect(api?.helpInformation()).toContain('call');
    expect(command).toBeDefined();
    const flags = command?.options.map((option) => option.long);
    expect(flags).toEqual(
      expect.arrayContaining(['--product', '--action', '--params', '--format']),
    );
    for (const flag of [
      '--url',
      '--endpoint',
      '--header',
      '--headers',
      '--token',
      '--api-key',
      '--auth-mode',
      '--region',
      '--version',
      '--file',
      '--stdin',
    ]) {
      expect(flags).not.toContain(flag);
    }
  });

  it.each([
    [],
    ['--product', 'AliyunDeliveryService'],
    ['--action', 'ListModelSeries'],
    ['--product', '', '--action', 'ListModelSeries'],
    ['--product', ' \t ', '--action', 'ListModelSeries'],
    ['--product', 'AliyunDeliveryService', '--action', ''],
    ['--product', 'AliyunDeliveryService', '--action', '\n '],
    ['--product'],
    ['--product', 'AliyunDeliveryService', '--action'],
    [...valid, '--params'],
  ])(
    'returns INVALID_ARGUMENT/4 for missing or blank required arguments %j before calling the service',
    async (...args) => {
      const result = await invoke(args);
      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: 'INVALID_ARGUMENT', exit_code: 4 },
      });
      expect(call).not.toHaveBeenCalled();
      expect(ensureAuthenticated).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    '{',
    '[1]',
    'null',
    'true',
    'false',
    '0',
    '"text"',
    '{"account_marker":"malformed-private-input"',
  ])(
    'rejects invalid params %s before calling the service without echoing the original input',
    async (params) => {
      const result = await invoke([...valid, '--params', params]);
      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: 'INVALID_ARGUMENT', exit_code: 4 },
      });
      expect(result.stderr).not.toContain('malformed-private-input');
      expect(result.stderr).not.toMatch(/\n\s+at\s/);
      expect(call).not.toHaveBeenCalled();
      expect(ensureAuthenticated).not.toHaveBeenCalled();
    },
  );

  it.each(['json', 'text', 'table'] as const)(
    'reports swallowed option values in the trailing %s format before service creation',
    async (format) => {
      const invalid = [
        ['--product', '--action', 'ListModelSeries'],
        ['--product', 'AliyunDeliveryService', '--action', '--params', '{}'],
        [...valid, '--params', '--product', 'AliyunDeliveryService'],
        ['--product'],
        ['--product', 'AliyunDeliveryService', '--action'],
        [...valid, '--params'],
      ];
      for (const argv of invalid) {
        const result = await invoke(argv, format);
        expect(result.exitCode, JSON.stringify(argv)).toBe(4);
        expect(result.stdout).toBe('');
        if (format === 'json') {
          expect(JSON.parse(result.stderr)).toMatchObject({
            error: { code: 'INVALID_ARGUMENT', exit_code: 4 },
          });
        } else {
          expect(result.stderr).toContain('Error:');
          expect(result.stderr.trimStart().startsWith('{')).toBe(false);
        }
      }
      expect(createServices).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
      expect(ensureAuthenticated).not.toHaveBeenCalled();
    },
  );

  it.each([
    [...valid, '--unrecognized'],
    [...valid, 'extra-argument'],
  ])(
    'preserves Commander handling for unknown options and excess arguments: %j',
    async (...argv) => {
      const result = await invoke(argv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/unknown option|too many arguments/);
      expect(result.stderr).not.toContain('INVALID_ARGUMENT');
      expect(call).not.toHaveBeenCalled();
    },
  );

  it('calls once with empty params in non-TTY mode without inferring business fields such as Language', async () => {
    const result = await invoke();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[0]).toMatchObject({
      product: 'AliyunDeliveryService',
      action: 'ListModelSeries',
      params: {},
    });
  });

  it('preserves nested JSON and routing-named fields within params only', async () => {
    const params = {
      Language: 'zh-CN',
      nested: { list: [1, false, null] },
      product: 'sfm_bailian',
      action: 'BroadScopeAspnGateway',
      authOptional: true,
    };
    await invoke([...valid, '--params', JSON.stringify(params)]);
    expect(call.mock.calls[0]?.[0]).toMatchObject({
      product: 'AliyunDeliveryService',
      action: 'ListModelSeries',
      params,
    });
    expect(call.mock.calls[0]?.[0]).not.toHaveProperty('authOptional');
  });
});

describe('api call output', () => {
  it.each([
    {
      value: {
        success: false,
        code: 'BUSINESS_VALUE',
        data: { amount: '0001.20' },
        error: 'business-field',
      },
    },
    { value: [{ nested: ['中文', null, 0] }] },
    { value: {} },
    { value: [] },
    { value: null },
    { value: false },
    { value: 0 },
    { value: '' },
  ])('returns JSON business value $value without wrapping or rewriting it', async ({ value }) => {
    call.mockResolvedValue(value);
    const result = await invoke();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(value);
    expect(renderApiCallInk).not.toHaveBeenCalled();
  });

  it('preserves control-character content in JSON without emitting raw ESC characters', async () => {
    const value = { text: `${String.fromCharCode(27)}[31m中文\u0007\r\n` };
    call.mockResolvedValue(value);
    const result = await invoke();
    expect(JSON.parse(result.stdout)).toEqual(value);
    expect(result.stdout).not.toContain(String.fromCharCode(27));
  });

  it('renders fields, array indices and nested JSON as text without terminal injection', async () => {
    call.mockResolvedValue([{ title: '中文', count: 0 }, 'safe\u001b[31mtext\u0007']);
    const result = await invoke(valid, 'text');
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('[0]');
    expect(result.stdout).toContain('[1]');
    expect(result.stdout).toContain('{"title":"中文","count":0}');
    for (const code of [0, 7, 27]) expect(result.stdout).not.toContain(String.fromCharCode(code));
    expect(renderApiCallInk).not.toHaveBeenCalled();
  });

  it('renders the same ViewModel through the shared Ink entry point for TTY table output', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const value = { total: 1, rows: [{ id: 'a' }] };
    call.mockResolvedValue(value);
    const result = await invoke(valid, 'table');
    expect(result.exitCode).toBeUndefined();
    expect(renderApiCallInk).toHaveBeenCalledExactlyOnceWith(buildApiCallViewModel(value));
  });

  it('uses isolated config defaults for text output and lets an explicit global json format override them', async () => {
    config.value = { 'output.format': 'text' };
    const textResult = await runCommand(registerApiCommands, ['api', 'call', ...valid]);
    expect(textResult.stdout).toContain('total');
    expect(textResult.stdout.trim().startsWith('{')).toBe(false);
    const jsonResult = await runCommand(registerApiCommands, [
      '--format',
      'json',
      'api',
      'call',
      ...valid,
    ]);
    expect(JSON.parse(jsonResult.stdout)).toEqual({ models: [], total: 0 });
  });
});

describe('api call errors and cancellation lifecycle', () => {
  it.each([
    { code: 'API_ERROR', exitCode: 1 },
    { code: 'AUTH_REQUIRED', exitCode: 2 },
    { code: 'TOKEN_EXPIRED', exitCode: 2 },
    { code: 'NETWORK_ERROR', exitCode: 3 },
    { code: 'RATE_LIMITED', exitCode: 5 },
    { code: 'SERVER_ERROR', exitCode: 6 },
    { code: 'NOT_FOUND', exitCode: 7 },
  ] as const)(
    'preserves exit $exitCode for $code and writes JSON errors only to stderr',
    async ({ code, exitCode }) => {
      call.mockRejectedValue(new CliError({ code, exitCode, message: 'synthetic error' }));
      const result = await invoke();
      expect(result.exitCode).toBe(exitCode);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code, exit_code: exitCode } });
      expect(process.listeners('SIGINT')).toEqual(listenersBefore);
      expect(interruptActiveCommand()).toBe(false);
    },
  );

  it('preserves the code of a CliError thrown by the output layer', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    renderApiCallInk.mockRejectedValue(
      new CliError({ code: 'OUTPUT_FAILED', exitCode: 4, message: 'render failed' }),
    );
    const result = await invoke(valid, 'table');
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('render failed');
    expect(process.listeners('SIGINT')).toEqual(listenersBefore);
    expect(interruptActiveCommand()).toBe(false);
  });

  it.each(['one-shot', 'REPL'] as const)(
    'cancels the request on %s, returns 130 and removes listeners',
    async (mode) => {
      runtime.repl = mode === 'REPL';
      call.mockImplementation(async ({ signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        if (mode === 'REPL') {
          expect(interruptActiveCommand()).toBe(true);
        } else {
          const installed = process
            .listeners('SIGINT')
            .filter((listener) => !listenersBefore.includes(listener));
          expect(installed.length).toBeGreaterThan(0);
          for (const listener of installed) listener.call(process, 'SIGINT');
        }
        expect(signal?.aborted).toBe(true);
        throw signal?.reason ?? new DOMException('Interrupted', 'AbortError');
      });
      const result = await invoke();
      expect(result.exitCode).toBe(130);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { exit_code: 130 } });
      expect(call).toHaveBeenCalledOnce();
      expect(process.listeners('SIGINT')).toEqual(listenersBefore);
      expect(interruptActiveCommand()).toBe(false);
    },
  );

  it('removes listeners after success so subsequent commands do not inherit cancellation state', async () => {
    await invoke();
    expect(process.listeners('SIGINT')).toEqual(listenersBefore);
    expect(interruptActiveCommand()).toBe(false);
    await invoke();
    expect(call).toHaveBeenCalledTimes(2);
    const first = call.mock.calls[0]?.[0].signal;
    const second = call.mock.calls[1]?.[0].signal;
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBeInstanceOf(AbortSignal);
    expect(second).not.toBe(first);
    expect(second?.aborted).toBe(false);
    expect(process.listeners('SIGINT')).toEqual(listenersBefore);
  });
});
