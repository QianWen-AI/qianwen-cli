import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workspace = path.resolve(__dirname, '../..');
const directories: string[] = [];
const pidFiles: string[] = [];

afterEach(() => {
  for (const file of pidFiles.splice(0)) {
    try {
      process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runShell(
  mode: 'success' | 'failure' | 'upgrade' | 'timeout' | 'upgrade-timeout' | 'noise',
) {
  const parent = path.join(workspace, '.local-test-tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'standalone-prepare-'));
  directories.push(directory);
  const source = readFileSync(path.join(workspace, 'install.sh'), 'utf8');
  expect(source).toContain('sleep 50');
  const library = path.join(directory, 'functions.sh');
  writeFileSync(library, source.replace(/\nmain "\$@"\s*$/, '\n').replace('sleep 50', 'sleep 1.5'));
  const binary = path.join(directory, 'CLI with spaces');
  const hangs = mode.endsWith('timeout');
  writeFileSync(
    binary,
    `#!/bin/sh
printf '%s' "$$" > "$QIANWEN_TEST_PID"
if [ -n "$QIANWEN_PLUGIN_PREPARE_DEADLINE" ]; then exit 9; fi
printf 'secret-untrusted-stdout'
printf 'secret-untrusted-stderr' >&2
${mode.startsWith('upgrade') ? 'printf "upgrade-required\\n" > "$QIANWEN_PLUGIN_PREPARE_REPORT"' : ''}
${mode === 'noise' ? 'printf "secret-untrusted-diagnostic\\033]52;hidden\\007" > "$QIANWEN_PLUGIN_PREPARE_REPORT"' : ''}
${hangs ? "trap '' TERM\nwhile :; do :; done" : `exit ${mode === 'success' ? 0 : 4}`}
`,
    { mode: 0o700 },
  );
  const pidFile = path.join(directory, 'pid');
  pidFiles.push(pidFile);
  const started = Date.now();
  const result = spawnSync(
    'sh',
    [
      '-c',
      '. "$1"; prepare_default_plugins "$2"; printf "%s/%s" "$QIANWEN_PLUGIN_PREPARE_REPORT" "$QIANWEN_PLUGIN_PREPARE_DEADLINE"',
      'fixture',
      library,
      binary,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        TMPDIR: directory,
        QIANWEN_TEST_PID: pidFile,
        QIANWEN_PLUGIN_PREPARE_REPORT: 'parent-report',
        QIANWEN_PLUGIN_PREPARE_DEADLINE: 'parent-deadline',
      },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('parent-report/parent-deadline');
  expect(readdirSync(directory).sort()).toEqual(['CLI with spaces', 'functions.sh', 'pid']);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
  return { result, elapsed: Date.now() - started };
}

describe('standalone preparation deadline and installer diagnostics', () => {
  it.each(['success', 'failure', 'upgrade', 'noise'] as const)(
    'handles %s and cleans up its child and report',
    (mode) => {
      const { result } = runShell(mode);
      if (mode === 'success') expect(result.stderr).toBe('');
      else if (mode === 'upgrade') {
        expect(result.stderr).toMatch(/upgrade.*CLI/i);
        expect(result.stderr).not.toMatch(/temporarily|retried automatically/i);
      } else expect(result.stderr).toMatch(/retried automatically/i);
      expect(result.stderr).not.toMatch(/secret-untrusted|hidden|--internal-/);
    },
  );

  it.each(['timeout', 'upgrade-timeout'] as const)(
    'hard-stops a child ignoring TERM after %s and preserves CLI installation',
    (mode) => {
      const { result, elapsed } = runShell(mode);
      expect(elapsed).toBeLessThan(4_000);
      expect(result.stderr).toMatch(
        mode === 'timeout' ? /retried automatically/i : /upgrade.*CLI/i,
      );
    },
  );

  it('uses bounded PowerShell process cmdlets compatible with CLM', () => {
    const source = readFileSync(path.join(workspace, 'install.ps1'), 'utf8');
    const body = source.slice(
      source.indexOf('function Initialize-DefaultPlugins'),
      source.indexOf('# ─── Constrained Language Mode'),
    );
    expect(body).toMatch(/Start-Process/);
    expect(body).toMatch(/Wait-Process[^\n]*-Timeout 50/);
    expect(body).toMatch(/Stop-Process/);
    expect(body).toContain('upgrade-required');
    expect(body).toContain('$global:LASTEXITCODE = $previousExitCode');
    expect(body).not.toMatch(/\.WaitForExit\(|::new\(|Add-Type/);
  });
});
