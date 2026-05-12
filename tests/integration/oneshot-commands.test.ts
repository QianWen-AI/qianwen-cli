/**
 * Integration tests for oneshot CLI commands.
 *
 * Strategy:
 * - Mock `createClient` → `MockApiClient` (zero real API calls)
 * - Mock `credentials` → bypass real authentication
 * - Mock `config/manager` → avoid reading real config files
 * - Test each command across three dimensions:
 *   1. JSON output: full pipeline verification via JSON.parse
 *   2. Text output: basic content assertions via toContain
 *   3. Error paths: invalid args / not-found → structured error + exit code
 *   4. Exit codes: verify exitCode for both success and error paths
 */
import { describe, it, expect, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock createClient → always return MockApiClient
vi.mock('../../src/api/client.js', async () => {
  const { MockApiClient } = await import('../fixtures/mock-client.js');
  return {
    createClient: async () => new MockApiClient(),
  };
});

// Mock auth → bypass real credential checks
vi.mock('../../src/auth/credentials.js', async (importOriginal) => {
  const original: any = await importOriginal();
  return {
    ...original,
    resolveCredentials: () => ({
      access_token: 'test-token',
      credentials: {
        access_token: 'test-token',
        expires_at: new Date(Date.now() + 7_200_000).toISOString(),
        user: { email: 'test@example.com', aliyunId: 'test_id' },
      },
      source: 'mock' as const,
    }),
    ensureAuthenticated: () => undefined,
    isTokenExpired: () => false,
    getTokenRemainingTime: () => '2h 0m',
    clearCredentialsCache: () => undefined,
    warnIfTokenExpiringSoon: () => undefined,
  };
});

// Mock config to avoid reading real config files
vi.mock('../../src/config/manager.js', async (importOriginal) => {
  const original: any = await importOriginal();
  const defaults: Record<string, string> = {
    'output.format': 'auto',
    'api.endpoint': 'https://cli.qianwenai.com',
    'auth.endpoint': 'https://t.qianwenai.com',
  };
  return {
    ...original,
    getEffectiveConfig: () => ({ ...defaults }),
    getConfigValue: (key: string) => defaults[key] ?? undefined,
    getConfigValueWithSource: (key: string) => ({
      value: defaults[key] ?? '',
      source: 'default' as const,
    }),
    getConfigEntries: (opts?: any) => Object.entries(defaults).map(([key, value]) => ({
      key,
      value,
      source: 'default' as const,
    })),
  };
});

import { runCommand, runCommandJSON, runCommandJSONErr } from './helpers.js';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('oneshot commands (integration)', () => {

  // ── Help & Version flags ────────────────────────────────────────────────

  describe('help & version flags', () => {
    it('--version outputs semver string', async () => {
      const result = await runCommand(['--version']);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    it('--help lists all top-level commands', async () => {
      const result = await runCommand(['--help']);
      const output = result.stdout;
      expect(output).toContain('auth');
      expect(output).toContain('models');
      expect(output).toContain('usage');
      expect(output).toContain('config');
      expect(output).toContain('doctor');
      expect(output).toContain('version');
    });
  });

  // ── Doctor ──────────────────────────────────────────────────────────────

  describe('doctor', () => {
    it('--format json: structured diagnostics with exit_code 0', async () => {
      const { data, exitCode } = await runCommandJSON(['doctor', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('checks');
      expect(json).toHaveProperty('summary');
      expect(json).toHaveProperty('exit_code', 0);

      expect(Array.isArray(json.checks)).toBe(true);
      expect(json.checks.length).toBeGreaterThan(0);

      for (const check of json.checks) {
        expect(check).toHaveProperty('name');
        expect(check).toHaveProperty('status');
        expect(check).toHaveProperty('detail');
        expect(['pass', 'fail', 'warn', 'info']).toContain(check.status);
      }

      expect(typeof json.summary.pass).toBe('number');
      expect(typeof json.summary.fail).toBe('number');
    });

    it('--format text: plain text diagnostics without ANSI codes', async () => {
      const result = await runCommand(['doctor', '--format', 'text']);
      // Text mode uses formatCheckLabel: cli_version → "CLI version", auth → "Auth"
      expect(result.stdout).toContain('CLI version');
      expect(result.stdout).toContain('Auth');
      expect(result.stdout).toContain('All critical checks passed');
      // Should NOT contain ANSI escape codes
      expect(result.stdout).not.toMatch(/\x1b\[/);
    });
  });

  // ── Models ──────────────────────────────────────────────────────────────

  describe('models', () => {
    it('list --format json: model array with required fields', async () => {
      const { data, exitCode } = await runCommandJSON(['models', 'list', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('models');
      expect(Array.isArray(json.models)).toBe(true);
      expect(json.models.length).toBeGreaterThan(0);

      const model = json.models[0];
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('modality');
    });

    it('info --format json: model detail with all fields', async () => {
      const { data, exitCode } = await runCommandJSON(['models', 'info', 'qwen3.6-plus', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('id', 'qwen3.6-plus');
      expect(json).toHaveProperty('modality');
      expect(json).toHaveProperty('description');
    });

    it('info --format text: plain text model detail', async () => {
      const result = await runCommand(['models', 'info', 'qwen3.6-plus', '--format', 'text']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('qwen3.6-plus');
    });

    it('info unknown-model --format json: error with MODEL_NOT_FOUND', async () => {
      const { data, exitCode } = await runCommandJSONErr(['models', 'info', 'nonexistent-model-xyz', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(1); // GENERAL_ERROR
      expect(json).toHaveProperty('error');
      expect(json.error).toHaveProperty('code', 'MODEL_NOT_FOUND');
      expect(json.error.message).toContain('nonexistent-model-xyz');
    });

    it('search --format json: filtered results', async () => {
      const { data, exitCode } = await runCommandJSON(['models', 'search', 'qwen', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('models');
      expect(Array.isArray(json.models)).toBe(true);
      expect(json.models.length).toBeGreaterThan(0);
    });

    it('search no-match --format json: empty result', async () => {
      const { data, exitCode } = await runCommandJSON(['models', 'search', 'zzz-nonexistent-zzz', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('models');
      expect(json.models).toHaveLength(0);
      expect(json).toHaveProperty('total', 0);
    });

    it('list --all --format json: returns every model in one response, no pagination keys', async () => {
      const { data, exitCode } = await runCommandJSON(['models', 'list', '--all', '--format', 'json']);
      const json = data as any;
      expect(exitCode).toBe(0);
      expect(json.all).toBe(true);
      expect(json.total).toBe(json.models.length);
      // --all means no pagination — those keys should be absent.
      expect(json).not.toHaveProperty('page');
      expect(json).not.toHaveProperty('total_pages');
    });

    it('list --page 9999 --format json: empty models, requested page preserved', async () => {
      const { data, exitCode } = await runCommandJSON(['models', 'list', '--page', '9999', '--format', 'json']);
      const json = data as any;
      expect(exitCode).toBe(0);
      expect(json.models).toEqual([]);
      // Echo the requested page back so Agents can detect end-of-list and stop
      // paginating, instead of looping forever on a clamped last page.
      expect(json.page).toBe(9999);
      expect(json.total_pages).toBeLessThan(9999);
    });

    it('list --input pdf --format json: INVALID_MODALITY error to stderr, exit 1', async () => {
      const { data, exitCode } = await runCommandJSONErr(['models', 'list', '--input', 'pdf', '--format', 'json']);
      const json = data as any;
      expect(exitCode).toBe(1);
      expect(json.error.code).toBe('INVALID_MODALITY');
      expect(json.error.message).toContain("'pdf'");
    });
  });

  // ── Usage ───────────────────────────────────────────────────────────────

  describe('usage', () => {
    it('summary --format json: usage data with period', async () => {
      const { data, exitCode } = await runCommandJSON(['usage', 'summary', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('period');
      // Should have at least one billing section
      const hasSection = json.free_tier || json.token_plan || json.pay_as_you_go;
      expect(hasSection).toBeTruthy();
    });

    it('breakdown --model --format json: rows and total', async () => {
      const { data, exitCode } = await runCommandJSON([
        'usage', 'breakdown',
        '--model', 'qwen3.6-plus',
        '--format', 'json',
      ]);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('rows');
      expect(json).toHaveProperty('total');
      expect(Array.isArray(json.rows)).toBe(true);
    });

    it('breakdown without --model: Commander error with non-zero exit', async () => {
      const result = await runCommand([
        'usage', 'breakdown',
        '--format', 'json',
      ]);

      // Commander catches missing required option before our action runs
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--model');
    });
  });

  // ── Auth ────────────────────────────────────────────────────────────────

  describe('auth', () => {
    it('status --format json: authenticated with user info', async () => {
      const { data, exitCode } = await runCommandJSON(['auth', 'status', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('authenticated', true);
      expect(json).toHaveProperty('server_verified', true);
    });

    it('status --format text: human-readable auth status', async () => {
      const result = await runCommand(['auth', 'status', '--format', 'text']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authenticated');
    });
  });

  // ── Config ──────────────────────────────────────────────────────────────

  describe('config', () => {
    it('list --format json: config entries wrapped in {configs}', async () => {
      const { data, exitCode } = await runCommandJSON(['config', 'list', '--format', 'json']);

      expect(exitCode).toBe(0);
      // Config list outputs an object with a configs array
      const json = data as any;
      expect(json).toHaveProperty('configs');
      expect(Array.isArray(json.configs)).toBe(true);
      expect(json.configs.length).toBeGreaterThan(0);
      expect(json.configs[0]).toHaveProperty('key');
      expect(json.configs[0]).toHaveProperty('value');
      expect(json.configs[0]).toHaveProperty('source');
    });

    it('list --format text: plain text table', async () => {
      const result = await runCommand(['config', 'list', '--format', 'text']);
      expect(result.exitCode).toBe(0);
      // Should contain config keys
      expect(result.stdout).toContain('output.format');
      expect(result.stdout).toContain('api.endpoint');
    });

    it('get default-only key --format json: returns value with source=default', async () => {
      // Mocked config has no overrides, so every key resolves to its built-in
      // default. Agents need the `source` field to know whether a value comes
      // from a project file, the global file, or the default.
      const { data, exitCode } = await runCommandJSON(['config', 'get', 'output.format', '--format', 'json']);
      const json = data as any;
      expect(exitCode).toBe(0);
      expect(json.key).toBe('output.format');
      expect(json.source).toBe('default');
      expect(json).toHaveProperty('value');
    });
  });

  // ── Version ─────────────────────────────────────────────────────────────

  describe('version', () => {
    it('--check --format json: version info with update status', async () => {
      const { data, exitCode } = await runCommandJSON(['version', '--check', '--format', 'json']);
      const json = data as any;

      expect(exitCode).toBe(0);
      expect(json).toHaveProperty('current');
      expect(json).toHaveProperty('latest');
      expect(json).toHaveProperty('update_available');
      expect(typeof json.current).toBe('string');
      expect(typeof json.update_available).toBe('boolean');
    });

    it('--check --format text: human-readable version info', async () => {
      const result = await runCommand(['version', '--check', '--format', 'text']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Current version');
      expect(result.stdout).toContain('Latest version');
    });
  });
});
