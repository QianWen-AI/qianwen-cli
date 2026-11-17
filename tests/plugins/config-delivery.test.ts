import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { registerPluginCommands } from '../../src/plugins/loader.js';

const state = vi.hoisted(() => ({
  config: {} as Record<string, string>,
  handler: vi.fn(),
}));
vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => state.config }));
vi.mock('./fixtures/argplugin/entry.mjs', () => ({ handlers: { echo: state.handler } }));

const publicConfig = {
  'output.format': 'json',
  'api.endpoint': 'https://api.test.qianwenai.com',
  'auth.endpoint': 'https://auth.test.qianwenai.com',
  'cache.ttl': '1234',
  'support.categorySource': 'remote',
  'model.endpoint': 'https://model.test.qianwenai.com',
};

beforeEach(() => {
  state.config = {
    ...publicConfig,
    'model.api_key': 'mock-model-key',
    'auth.token': 'mock-auth-token',
    'future.credential': 'mock-future-value',
    innocuousFutureSetting: 'must-also-be-omitted',
  };
  state.handler.mockReset();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('external handler config uses an explicit allowlist', () => {
  it('passes only safe keys and a blank model key without changing host config', async () => {
    const original = { ...state.config };
    const received: Array<Record<string, string>> = [];
    state.handler.mockImplementation(async (ctx: unknown) => {
      const config = (ctx as { config: Record<string, string> }).config;
      received.push({ ...config });
      config['output.format'] = 'text';
      config['model.api_key'] = 'mock-plugin-mutation';
    });
    const program = new Command().option('--format <format>').exitOverride();
    registerPluginCommands(program, [
      {
        name: '@qianwenai/config-fixture',
        pkgDir: fileURLToPath(new URL('./fixtures/argplugin/', import.meta.url)),
        manifest: {
          command: 'config-fixture',
          entry: './entry.mjs',
          handlerKey: 'echo',
          auth: 'optional',
        },
      },
    ]);

    await program.parseAsync(['config-fixture', '--format', 'json'], { from: 'user' });

    expect(state.handler).toHaveBeenCalledOnce();
    expect(received).toEqual([{ ...publicConfig, 'model.api_key': '' }]);
    expect(state.config).toEqual(original);
  });
});
