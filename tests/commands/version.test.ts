import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from '../helpers/run-command.js';
import { makeMockApiClient } from '../helpers/api-client.js';
import type { ApiClient } from '../../src/api/client.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

const holder: { client: ApiClient } = { client: makeMockApiClient() };

vi.mock('../../src/api/client.js', () => ({
  createClient: async () => holder.client,
}));

const { registerVersionCommand, registerUpdateCommand } = await import(
  '../../src/commands/version.js'
);

beforeEach(() => {
  holder.client = makeMockApiClient();
});

describe('version command', () => {
  it('plain version → JSON mode prints {version: ...}', async () => {
    const r = await runCommand(
      (program) => registerVersionCommand(program),
      ['version', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty('version');
    expect(typeof payload.version).toBe('string');
  });

  it(`plain version → text mode prints "${s.cliName} v..."`, async () => {
    const r = await runCommand(
      (program) => registerVersionCommand(program),
      ['version', '--format', 'text'],
    );
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toMatch(new RegExp(`^${s.cliName} v`));
  });

  it('--check (no update) → JSON mode reports update_available=false', async () => {
    holder.client = makeMockApiClient({
      checkVersion: async () => ({
        current: '1.0.0',
        latest: '1.0.0',
        update_available: false,
      }),
    });
    const r = await runCommand(
      (program) => registerVersionCommand(program),
      ['version', '--check', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.update_available).toBe(false);
  });
});

describe('update command', () => {
  it('already up to date (JSON) → message says so, exit 0', async () => {
    holder.client = makeMockApiClient({
      checkVersion: async () => ({
        current: '1.0.0',
        latest: '1.0.0',
        update_available: false,
      }),
    });
    const r = await runCommand(
      (program) => registerUpdateCommand(program),
      ['update', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.update_available).toBe(false);
    expect(payload.message).toMatch(/up to date/i);
  });

  it('already up to date (text) → prints checkmark line', async () => {
    holder.client = makeMockApiClient({
      checkVersion: async () => ({
        current: '1.0.0',
        latest: '1.0.0',
        update_available: false,
      }),
    });
    const r = await runCommand(
      (program) => registerUpdateCommand(program),
      ['update', '--format', 'text'],
    );
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toMatch(/up to date/i);
  });

  it('update available (JSON) → message says updating', async () => {
    holder.client = makeMockApiClient({
      checkVersion: async () => ({
        current: '1.0.0',
        latest: '1.1.0',
        update_available: true,
      }),
    });
    const r = await runCommand(
      (program) => registerUpdateCommand(program),
      ['update', '--format', 'json'],
    );
    expect(r.exitCode).toBeUndefined();
    const payload = JSON.parse(r.stdout);
    expect(payload.update_available).toBe(true);
    expect(payload.latest).toBe('1.1.0');
  });
});
