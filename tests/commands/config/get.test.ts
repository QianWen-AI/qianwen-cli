import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';

vi.mock('../../../src/config/schema.js', () => ({
  isPublicKey: (k: string) => ['output.format', 'api.endpoint'].includes(k),
}));
vi.mock('../../../src/config/manager.js', () => ({
  getConfigValue: () => 'auto',
  getConfigValueWithSource: (k: string) => ({
    value: k === 'output.format' ? 'auto' : 'https://example.com',
    source: 'default',
    sourcePath: undefined,
  }),
}));

const { configGet } = await import('../../../src/commands/config/get.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function buildGet(program: import('commander').Command) {
  const config = program.command('config');
  config
    .command('get')
    .argument('<key>')
    .option('--format <fmt>')
    .action((key: string, opts: { format?: string }) => {
      configGet(key, opts, program.opts().format as string | undefined);
    });
}

describe('config get command', () => {
  it('JSON mode → returns key/value/source', async () => {
    const r = await runCommand(buildGet, ['config', 'get', 'output.format', '--format', 'json']);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.key).toBe('output.format');
    expect(payload.value).toBe('auto');
    expect(payload.source).toBe('default');
  });

  it('text mode → prints raw value', async () => {
    const r = await runCommand(buildGet, ['config', 'get', 'output.format', '--format', 'text']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('auto');
  });

  it('unknown key (JSON) → CONFIG_ERROR on stderr, exit 4', async () => {
    const r = await runCommand(buildGet, ['config', 'get', 'nonexistent.key', '--format', 'json']);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain('CONFIG_ERROR');
    expect(r.stderr).toContain('nonexistent.key');
  });

  it('unknown key (text) → "Error:" on stderr, exit 4', async () => {
    const r = await runCommand(buildGet, ['config', 'get', 'nonexistent.key', '--format', 'text']);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/Error:.*Unknown config key 'nonexistent\.key'/);
  });
});
