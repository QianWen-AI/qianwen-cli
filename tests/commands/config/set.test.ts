import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';

const setSpy = vi.fn();

vi.mock('../../../src/config/schema.js', () => ({
  isPublicKey: (k: string) => ['output.format', 'api.endpoint'].includes(k),
  validateConfigValue: (k: string, v: string) =>
    k === 'output.format' && !['auto', 'json', 'text', 'table'].includes(v)
      ? `Invalid value '${v}' for ${k}`
      : null,
}));
vi.mock('../../../src/config/manager.js', () => ({
  setConfigValue: (k: string, v: string) => setSpy(k, v),
  getConfigValue: () => 'auto',
}));

const { configSet } = await import('../../../src/commands/config/set.js');

beforeEach(() => {
  setSpy.mockClear();
});

function buildSet(program: import('commander').Command) {
  const config = program.command('config');
  config
    .command('set')
    .argument('<key>')
    .argument('<value>')
    .option('--format <fmt>')
    .action((key: string, value: string, opts: { format?: string }) => {
      configSet(key, value, opts, program.opts().format as string | undefined);
    });
}

describe('config set command', () => {
  it('valid key + value (JSON) → returns ok=true, persists value', async () => {
    const r = await runCommand(buildSet, [
      'config', 'set', 'output.format', 'json', '--format', 'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.key).toBe('output.format');
    expect(payload.value).toBe('json');
    expect(setSpy).toHaveBeenCalledWith('output.format', 'json');
  });

  it('valid key + value (text) → prints checkmark', async () => {
    const r = await runCommand(buildSet, [
      'config', 'set', 'output.format', 'text', '--format', 'text',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toMatch(/Set output\.format = text/);
  });

  it('unknown key → CONFIG_ERROR, exit 4, no persist', async () => {
    const r = await runCommand(buildSet, [
      'config', 'set', 'nonexistent.key', 'foo', '--format', 'json',
    ]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain('CONFIG_ERROR');
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('invalid value → CONFIG_ERROR with validation message, exit 4', async () => {
    const r = await runCommand(buildSet, [
      'config', 'set', 'output.format', 'bogus', '--format', 'json',
    ]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain('CONFIG_ERROR');
    expect(r.stderr).toContain('bogus');
    expect(setSpy).not.toHaveBeenCalled();
  });
});
