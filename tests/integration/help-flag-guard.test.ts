/**
 * Integration tests for the program-wide help-flag guard.
 *
 * Commander assigns the token after a value-taking option as that option's
 * value, so `<cmd> --opt --help` swallows the help flag and the action would
 * otherwise run with "--help" as input. The guard (registered on the real
 * program via createProgram) detects a swallowed -h/--help anywhere in the
 * option chain and renders help instead — uniformly, for every command.
 *
 * These run through the real createProgram so the hook is exercised; the guard
 * fires in preAction before any action body, so no auth/network/config is hit.
 */
import { describe, it, expect } from 'vitest';
import { runCommand } from './helpers.js';

describe('help-flag guard — swallowed -h/--help renders help', () => {
  it('support list --page --help shows help, exit 0', async () => {
    const r = await runCommand(['support', 'list', '--page', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('support list');
  });

  it('support list --page -h shows help, exit 0', async () => {
    const r = await runCommand(['support', 'list', '--page', '-h']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage');
  });

  it('support reply --message -h shows help, does not send', async () => {
    const r = await runCommand(['support', 'reply', '0065VALID001', '--message', '-h']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).not.toContain('sent');
  });

  it('support rate --rating -h shows help (uniform across the command family)', async () => {
    const r = await runCommand(['support', 'rate', '0065VALID001', '--rating', '-h']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage');
  });

  it('catches a help flag swallowed by the global --format option', async () => {
    const r = await runCommand(['support', 'list', '--format', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage');
  });
});
