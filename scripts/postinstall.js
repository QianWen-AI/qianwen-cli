import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const preparationTimeoutMs = 45_000;
const cleanupTimeoutMs = 5_000;
const retryMessage =
  'QianWen CLI is installed. Default plugins are temporarily unavailable; they will be retried automatically when you run a corresponding plugin command.\n';
const upgradeMessage =
  'QianWen CLI is installed. A default plugin requires a newer CLI. Upgrade QianWen CLI, then run the plugin command again.\n';

// Dependency installation in a source checkout must not modify the developer's plugins.
if (!existsSync(join(packageDirectory, 'src/plugins'))) {
  const binary = join(packageDirectory, 'dist/bin/qianwen.js');
  if (!existsSync(binary)) {
    process.stderr.write(retryMessage);
  } else {
    let reportDirectory;
    try {
      reportDirectory = mkdtempSync(join(tmpdir(), 'qianwen-prepare-'));
      const report = join(reportDirectory, 'status');
      writeFileSync(report, '', { mode: 0o600 });
      const result = spawnSync(process.execPath, [binary, '--internal-prepare-default-plugins'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          QIANWEN_PLUGIN_PREPARE_DEADLINE: String(Date.now() + preparationTimeoutMs),
          QIANWEN_PLUGIN_PREPARE_REPORT: report,
        },
        timeout: preparationTimeoutMs + cleanupTimeoutMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
      });
      if (result.error || result.status !== 0) {
        const metadata = lstatSync(report);
        const upgrade =
          metadata.isFile() &&
          metadata.size <= 32 &&
          readFileSync(report, 'utf8').trim() === 'upgrade-required';
        process.stderr.write(upgrade ? upgradeMessage : retryMessage);
      }
    } catch {
      process.stderr.write(retryMessage);
    } finally {
      if (reportDirectory) {
        try {
          rmSync(reportDirectory, { recursive: true, force: true });
        } catch {
          /* Best effort after installation. */
        }
      }
    }
  }
}
