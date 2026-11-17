import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = join(root, '.local-test-tmp');
const startupAllowanceMs = process.env.CI === 'true' || process.env.CI === '1' ? 10_000 : 5_000;
const processTimeoutMs = 50_000 + startupAllowanceMs;
const testTimeoutMs = processTimeoutMs + startupAllowanceMs;
const directories: string[] = [];
const pidFiles: string[] = [];

afterEach(() => {
  for (const file of pidFiles.splice(0)) {
    try {
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
    } catch {
      /* The fixture did not start or already exited. */
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'install hook '));
  directories.push(directory);
  const packageDirectory = join(directory, 'package with spaces');
  mkdirSync(join(packageDirectory, 'scripts'), { recursive: true });
  mkdirSync(join(packageDirectory, 'dist/bin'), { recursive: true });
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
  const pidFile = join(directory, 'pid');
  pidFiles.push(pidFile);
  return { directory, packageDirectory, record: join(directory, 'invocations.json'), pidFile };
}

function fakeCli(binary: string, exitCode = 0): void {
  writeFileSync(
    binary,
    `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.QIANWEN_TEST_HOOK_PID, String(process.pid));
writeFileSync(process.env.QIANWEN_TEST_HOOK_RECORD, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ plugins: [] }));
process.stderr.write(${JSON.stringify(exitCode === 0 ? '' : 'simulated registry unavailable')});
process.exitCode = ${exitCode};
`,
  );
}

describe('npm postinstall plugin preparation', () => {
  it.each([0, 4])(
    'uses the installed CLI without development dependencies and preserves installation for exit %i',
    (exitCode) => {
      const { directory, packageDirectory, record, pidFile } = fixture();
      const hook = join(packageDirectory, 'scripts/postinstall.js');
      copyFileSync(join(root, 'scripts/postinstall.js'), hook);
      fakeCli(join(packageDirectory, 'dist/bin/qianwen.js'), exitCode);
      const result = spawnSync(process.execPath, [hook], {
        cwd: directory,
        env: {
          ...process.env,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          QIANWEN_TEST_HOOK_RECORD: record,
          QIANWEN_TEST_HOOK_PID: pidFile,
        },
        encoding: 'utf8',
        timeout: processTimeoutMs,
        killSignal: 'SIGKILL',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual([
        '--internal-prepare-default-plugins',
      ]);
      expect(result.stdout).toBe('');
      expect(existsSync(join(packageDirectory, 'node_modules'))).toBe(false);
      if (exitCode === 0) expect(result.stderr).toBe('');
      else expect(result.stderr).toMatch(/retried automatically when you run.*plugin command/i);
      expect(result.stderr).not.toMatch(/plugin prepare|--internal-/);
    },
    testTimeoutMs,
  );

  it(
    'does not run plugin preparation while dependencies are installed in a source checkout',
    () => {
      const { directory, packageDirectory, record, pidFile } = fixture();
      const hook = join(packageDirectory, 'scripts/postinstall.js');
      copyFileSync(join(root, 'scripts/postinstall.js'), hook);
      mkdirSync(join(packageDirectory, 'src/plugins'), { recursive: true });
      fakeCli(join(packageDirectory, 'dist/bin/qianwen.js'));
      const result = spawnSync(process.execPath, [hook], {
        cwd: directory,
        env: {
          ...process.env,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          QIANWEN_TEST_HOOK_RECORD: record,
          QIANWEN_TEST_HOOK_PID: pidFile,
        },
        encoding: 'utf8',
        timeout: processTimeoutMs,
        killSignal: 'SIGKILL',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(existsSync(record)).toBe(false);
      expect(result.stdout).toBe('');
    },
    testTimeoutMs,
  );

  it(
    'keeps the CLI installation successful when its binary is not ready yet',
    () => {
      const { directory, packageDirectory, record, pidFile } = fixture();
      const hook = join(packageDirectory, 'scripts/postinstall.js');
      copyFileSync(join(root, 'scripts/postinstall.js'), hook);
      const result = spawnSync(process.execPath, [hook], {
        cwd: directory,
        env: {
          ...process.env,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          QIANWEN_TEST_HOOK_RECORD: record,
          QIANWEN_TEST_HOOK_PID: pidFile,
        },
        encoding: 'utf8',
        timeout: processTimeoutMs,
        killSignal: 'SIGKILL',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(existsSync(record)).toBe(false);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/retried automatically when you run.*plugin command/i);
      expect(result.stderr).not.toMatch(/plugin prepare|--internal-/);
    },
    testTimeoutMs,
  );

  it('ships its runtime-only hook in package.json', () => {
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(metadata.files).toContain('scripts/postinstall.js');
    expect(metadata.scripts.postinstall).toBe('node scripts/postinstall.js');
  });
});

describe('standalone binary installer plugin preparation', () => {
  it.each([0, 4])(
    'preserves the shell installer result when preparation exits %i',
    (exitCode) => {
      const { directory, record, pidFile } = fixture();
      const source = readFileSync(join(root, 'install.sh'), 'utf8');
      const mainCall = /\nmain "\$@"\s*$/;
      expect(source).toMatch(mainCall);
      const functions = join(directory, 'installer-functions.sh');
      writeFileSync(functions, source.replace(mainCall, '\n'));
      const binary = join(directory, 'CLI with spaces');
      writeFileSync(
        binary,
        `#!/bin/sh\nprintf '%s' "$$" > "$QIANWEN_TEST_HOOK_PID"\nprintf '%s\\n' "$@" > "$QIANWEN_TEST_HOOK_RECORD"\nexit ${exitCode}\n`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        'sh',
        [
          '-c',
          '. "$1"; prepare_default_plugins "$2"; printf "installation-kept\\n"',
          'install-hook-test',
          functions,
          binary,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            TMPDIR: directory,
            TMP: directory,
            TEMP: directory,
            QIANWEN_TEST_HOOK_RECORD: record,
            QIANWEN_TEST_HOOK_PID: pidFile,
          },
          encoding: 'utf8',
          timeout: processTimeoutMs,
          killSignal: 'SIGKILL',
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual([
        '--internal-prepare-default-plugins',
      ]);
      expect(result.stdout).toBe('installation-kept\n');
      if (exitCode === 0) expect(result.stderr).toBe('');
      else expect(result.stderr).toMatch(/retried automatically when you run.*plugin command/i);
      expect(result.stderr).not.toMatch(/plugin prepare|--internal-/);
    },
    testTimeoutMs,
  );

  it('connects both installers to preparation after verifying the installed binary', () => {
    const shell = readFileSync(join(root, 'install.sh'), 'utf8');
    expect(shell).toContain('prepare_default_plugins "${install_dir}/qianwen"');
    const powershell = readFileSync(join(root, 'install.ps1'), 'utf8');
    expect(powershell).toContain('Initialize-DefaultPlugins -CliPath $exePath');
    expect(powershell).toMatch(/Start-Process[^\n]+--internal-prepare-default-plugins/);
    expect(powershell).toMatch(/Write-Error[^\n]+-ErrorAction Continue/);
    expect(powershell).not.toContain('plugin prepare');
  });
});
