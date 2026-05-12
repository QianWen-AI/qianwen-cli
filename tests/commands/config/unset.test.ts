import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../../helpers/run-command.js';

const unsetSpy = vi.fn();

vi.mock('../../../src/config/schema.js', () => ({
  isPublicKey: (k: string) => ['output.format', 'api.endpoint'].includes(k),
}));
vi.mock('../../../src/config/manager.js', () => ({
  unsetConfigValue: (k: string) => unsetSpy(k),
  getConfigValue: () => 'auto',
}));

const { configUnset } = await import('../../../src/commands/config/unset.js');

beforeEach(() => {
  unsetSpy.mockClear();
});

function buildUnset(program: import('commander').Command) {
  const config = program.command('config');
  config
    .command('unset')
    .argument('<key>')
    .option('--format <fmt>')
    .action((key: string, opts: { format?: string }) => {
      configUnset(key, opts, program.opts().format as string | undefined);
    });
}

describe('config unset command', () => {
  it('valid key (JSON) → returns ok=true and removed=true', async () => {
    const r = await runCommand(buildUnset, [
      'config', 'unset', 'output.format', '--format', 'json',
    ]);
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.removed).toBe(true);
    expect(unsetSpy).toHaveBeenCalledWith('output.format');
  });

  it('valid key (text) → prints checkmark', async () => {
    const r = await runCommand(buildUnset, [
      'config', 'unset', 'output.format', '--format', 'text',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toMatch(/Unset output\.format/);
  });

  it('unknown key → CONFIG_ERROR, exit 4, no persist', async () => {
    const r = await runCommand(buildUnset, [
      'config', 'unset', 'nonexistent.key', '--format', 'json',
    ]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain('CONFIG_ERROR');
    expect(unsetSpy).not.toHaveBeenCalled();
  });
});
