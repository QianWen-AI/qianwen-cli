import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

it('builds and lists default plugin metadata without reading archives or installing plugins', () => {
  const temporaryRoot = join(root, '.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'metadata-build-'));
  try {
    const guard = join(directory, 'deny-plugin-io.mjs');
    writeFileSync(
      guard,
      `import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const check = (path) => {
  if (String(path).endsWith('.tgz')) throw new Error('Plugin archives must not be read by a CLI build or listing');
};
for (const name of ['readFileSync', 'statSync', 'realpathSync']) {
  const original = fs[name];
  fs[name] = (...args) => { check(args[0]); return original(...args); };
}
const readFile = fs.promises.readFile;
fs.promises.readFile = (...args) => { check(args[0]); return readFile(...args); };
os.homedir = () => process.env.QIANWEN_TEST_STATE;
os.tmpdir = () => process.env.QIANWEN_TEST_STATE;
globalThis.fetch = async () => { throw new Error('Network must not be used by a CLI build or listing'); };
syncBuiltinESMExports();
`,
    );
    const state = join(directory, 'state');
    mkdirSync(state);
    const output = join(directory, 'cli');
    const env = {
      ...process.env,
      TSUP_MODE: 'production',
      QIANWEN_BUILD_OUTDIR: output,
      QIANWEN_CONFIG_DIR: state,
      QIANWEN_KEYRING: 'no',
      QIANWEN_PLUGIN_ARCHIVE_ROOT: '',
      QIANWEN_TEST_STATE: state,
      NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
    };
    const tsupPackagePath = require.resolve('tsup/package.json');
    const tsupPackage = JSON.parse(readFileSync(tsupPackagePath, 'utf8'));
    const tsupEntry = typeof tsupPackage.bin === 'string' ? tsupPackage.bin : tsupPackage.bin.tsup;
    const build = spawnSync(process.execPath, [resolve(dirname(tsupPackagePath), tsupEntry)], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 25_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(build.error).toBeUndefined();
    expect(build.status, build.stderr || build.stdout).toBe(0);
    const listing = spawnSync(
      process.execPath,
      [join(output, 'bin/qianwen.js'), 'plugin', 'list', '--format', 'json'],
      {
        cwd: directory,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(listing.error).toBeUndefined();
    expect(listing.status, listing.stderr).toBe(0);
    const plugins = JSON.parse(listing.stdout).plugins;
    const configured = JSON.parse(readFileSync(join(root, 'plugins.preload.json'), 'utf8')).plugins;
    for (const plugin of configured) {
      expect(plugins).toContainEqual(
        expect.objectContaining({
          name: plugin.name,
          version: plugin.version,
          origin: 'default',
          source: plugin.source.type,
          installed: false,
          status: 'pending',
        }),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
