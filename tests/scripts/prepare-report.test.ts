import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workspace = path.resolve(__dirname, '../..');
const directories: string[] = [];
const pidFiles: string[] = [];
const isCI = process.env.CI === 'true' || process.env.CI === '1';
const startupAllowanceMs = isCI ? 10_000 : 5_000;
const preparationTimeoutMs = isCI ? 10_000 : 5_000;
const cleanupTimeoutMs = isCI ? 2_000 : 1_000;

afterEach(() => {
  for (const file of pidFiles.splice(0)) {
    try {
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('npm preparation report', () => {
  for (const mode of ['upgrade', 'failure', 'noise', 'timeout', 'upgrade-timeout'] as const) {
    const hangs = mode.endsWith('timeout');
    const hookTimeoutMs = hangs ? preparationTimeoutMs + cleanupTimeoutMs : 50_000;
    const processTimeoutMs = hookTimeoutMs + startupAllowanceMs;
    it(
      `emits a bounded diagnostic for ${mode} and keeps installation successful`,
      () => {
        const parent = path.join(workspace, '.local-test-tmp');
        mkdirSync(parent, { recursive: true });
        const directory = mkdtempSync(path.join(parent, 'npm-prepare-report-'));
        directories.push(directory);
        const temporary = path.join(directory, 'tmp');
        mkdirSync(temporary);
        mkdirSync(path.join(directory, 'scripts'));
        mkdirSync(path.join(directory, 'dist/bin'), { recursive: true });
        writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
        const hook = readFileSync(path.join(workspace, 'scripts/postinstall.js'), 'utf8');
        expect(hook).toContain('45_000');
        expect(hook).toContain('5_000');
        writeFileSync(
          path.join(directory, 'scripts/postinstall.js'),
          hangs
            ? hook
                .replace('45_000', String(preparationTimeoutMs))
                .replace('5_000', String(cleanupTimeoutMs))
            : hook,
        );
        const pidFile = path.join(directory, 'pid');
        pidFiles.push(pidFile);
        writeFileSync(
          path.join(directory, 'dist/bin/qianwen.js'),
          `import fs from 'node:fs';
fs.writeFileSync(process.env.QIANWEN_TEST_PID, String(process.pid));
${mode.endsWith('timeout') ? "process.on('SIGTERM', () => {});" : ''}
${mode === 'upgrade-timeout' ? 'await new Promise((resolve) => setTimeout(resolve, 1_500));' : ''}
${mode.startsWith('upgrade') ? 'fs.writeFileSync(process.env.QIANWEN_PLUGIN_PREPARE_REPORT, "upgrade-required\\n");' : ''}
${mode === 'noise' ? 'fs.writeFileSync(process.env.QIANWEN_PLUGIN_PREPARE_REPORT, "upgrade-required\\n".repeat(1000));' : ''}
process.stderr.write('secret-untrusted-diagnostic');
${mode.endsWith('timeout') ? 'setInterval(() => {}, 100);' : 'process.exitCode = 4;'}
`,
        );
        const result = spawnSync(
          process.execPath,
          [path.join(directory, 'scripts/postinstall.js')],
          {
            cwd: directory,
            env: {
              ...process.env,
              TMPDIR: temporary,
              TEMP: temporary,
              TMP: temporary,
              QIANWEN_TEST_PID: pidFile,
            },
            encoding: 'utf8',
            timeout: processTimeoutMs,
            killSignal: 'SIGKILL',
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(
          mode.startsWith('upgrade') ? /upgrade.*CLI/i : /retried automatically/i,
        );
        expect(result.stderr).not.toContain('secret-untrusted');
        expect(readdirSync(temporary)).toEqual([]);
        const pid = Number(readFileSync(pidFile, 'utf8'));
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      },
      processTimeoutMs + startupAllowanceMs,
    );
  }
});
