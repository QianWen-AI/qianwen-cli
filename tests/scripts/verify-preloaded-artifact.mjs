import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function verifyPreloadedArtifact(
  root,
  artifact = join(root, '.plugins-local/cli/bin/qianwen.js'),
) {
  const configuration = JSON.parse(readFileSync(join(root, 'plugins.preload.json'), 'utf8'));
  const verification = join(root, '.plugins-local/verification/generic');
  mkdirSync(verification, { recursive: true });
  const temporaryDirectory = mkdtempSync(join(verification, 'run-'));
  const isolatedDirectory = join(temporaryDirectory, 'state');
  mkdirSync(isolatedDirectory);
  const preload = join(temporaryDirectory, 'offline-preload.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const isolatedDirectory = process.env.PLUGIN_VERIFY_STATE;
os.homedir = () => isolatedDirectory;
os.tmpdir = () => isolatedDirectory;
globalThis.fetch = async () => { throw new Error('Unexpected network request during artifact verification'); };
const blocked = () => { throw new Error('External commands are disabled during artifact verification'); };
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']) childProcess[name] = blocked;
if (!process.env.QIANWEN_PLUGIN_ARCHIVE_ROOT) {
  const check = (path) => {
    if (String(path).endsWith('.tgz')) throw new Error('Help and listing must not read plugin archives');
  };
  for (const name of ['readFileSync', 'statSync', 'realpathSync']) {
    const original = fs[name];
    fs[name] = (...args) => { check(args[0]); return original(...args); };
  }
  const readFile = fs.promises.readFile;
  fs.promises.readFile = (...args) => { check(args[0]); return readFile(...args); };
}
syncBuiltinESMExports();
`,
  );

  const results = [];
  const run = (args, prepare = false) => {
    const result = spawnSync(process.execPath, ['--import', preload, artifact, ...args], {
      cwd: isolatedDirectory,
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        QIANWEN_CONFIG_DIR: isolatedDirectory,
        QIANWEN_KEYRING: 'no',
        ...(prepare ? { QIANWEN_PLUGIN_ARCHIVE_ROOT: root } : {}),
        PLUGIN_VERIFY_STATE: isolatedDirectory,
        TMPDIR: isolatedDirectory,
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const record = { args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    results.push(record);
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };

  try {
    run(['--version']);
    const listing = JSON.parse(run(['plugin', 'list', '--format', 'json']));
    const rootHelp = run(['--help']);
    const visitHelp = (manifest, ancestors = []) => {
      const command = manifest.command.trim().split(/\s+/)[0];
      const path = [...ancestors, command];
      const help = run([...path, '--help']);
      assert.ok(help.includes(command), `Missing help for ${path.join(' ')}`);
      for (const child of manifest.subcommands ?? []) visitHelp(child, path);
    };
    for (const plugin of configuration.plugins) {
      const listed = listing.plugins.find((candidate) => candidate.name === plugin.name);
      assert.ok(listed, `Configured package missing from plugin list: ${plugin.name}`);
      assert.equal(listed.version, plugin.version);
      assert.equal(listed.source, plugin.source.type);
      assert.equal(listed.origin, 'default');
      assert.equal(listed.status, 'pending');
      assert.equal(listed.installed, false);
      assert.equal(listed.enabled, true);
      assert.ok(rootHelp.includes(plugin.command));
      visitHelp(plugin);
    }
    const afterHelp = JSON.parse(run(['plugin', 'list', '--format', 'json']));
    for (const plugin of configuration.plugins) {
      const listed = afterHelp.plugins.find((candidate) => candidate.name === plugin.name);
      assert.equal(listed?.installed, false, `Help installed ${plugin.name}`);
    }
    const canPrepareOffline = configuration.plugins.every(
      (plugin) => plugin.source.type === 'archive',
    );
    if (canPrepareOffline) {
      const prepared = JSON.parse(run(['--internal-prepare-default-plugins'], true));
      assert.equal(prepared.plugins.length, configuration.plugins.length);
      const installed = JSON.parse(run(['plugin', 'list', '--format', 'json']));
      for (const plugin of configuration.plugins) {
        assert.ok(
          prepared.plugins.some(
            (candidate) =>
              candidate.name === plugin.name &&
              candidate.version === plugin.version &&
              candidate.status === 'installed',
          ),
        );
        const listed = installed.plugins.find((candidate) => candidate.name === plugin.name);
        assert.equal(listed?.origin, 'default');
        assert.equal(listed?.source, 'archive');
        assert.equal(listed?.status, 'installed');
        assert.equal(listed?.installed, true);
      }
    }
    return {
      artifact,
      pluginCount: configuration.plugins.length,
      commandCount: results.length,
      preparation: canPrepareOffline ? 'verified-offline' : 'skipped-npm-network-disabled',
      results,
    };
  } finally {
    writeFileSync(
      join(verification, 'artifact-report.json'),
      JSON.stringify(results, null, 2) + '\n',
    );
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'));
  const report = verifyPreloadedArtifact(root);
  console.log(
    `PASS: ${report.pluginCount} configured plugins, ${report.commandCount} artifact commands`,
  );
}
