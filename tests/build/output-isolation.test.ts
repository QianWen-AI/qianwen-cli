import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function configuredOutputs(
  nodeEnv: string | undefined,
  tsupMode?: string,
  outputDirectory?: string,
): Promise<{ entry: unknown; outDir: string }[]> {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('TSUP_MODE', tsupMode);
  vi.stubEnv('QIANWEN_BUILD_OUTDIR', outputDirectory);
  vi.resetModules();

  const { default: exportedConfig } = await import('../../tsup.config.js');
  const resolved: unknown =
    typeof exportedConfig === 'function' ? await exportedConfig({}) : exportedConfig;
  const configs: unknown[] = Array.isArray(resolved) ? resolved : [resolved];

  return configs.map((config) => {
    if (
      typeof config !== 'object' ||
      config === null ||
      !('outDir' in config) ||
      !('entry' in config)
    ) {
      throw new Error('Each build configuration must select its entry and output directory');
    }
    if (typeof config.outDir !== 'string') {
      throw new Error('Build output directory must be a string');
    }
    return { entry: config.entry, outDir: config.outDir };
  });
}

describe('development and production build output isolation', () => {
  // The first tsup.config import pays the full transform cost, which exceeds
  // the 5s default on a contended CI runner.
  it.each([
    { mode: 'production environment', nodeEnv: 'production', tsupMode: undefined },
    {
      mode: 'production script overriding NODE_ENV',
      nodeEnv: 'development',
      tsupMode: 'production',
    },
  ])(
    'keeps the production CLI under dist/bin for $mode',
    async ({ nodeEnv, tsupMode }) => {
      const outputs = await configuredOutputs(nodeEnv, tsupMode);

      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.entry).toBeDefined();
      expect(outputs[0]?.outDir).toBe('dist/bin');
    },
    30_000,
  );

  it.each([
    { mode: 'explicit development build', nodeEnv: 'development', tsupMode: undefined },
    { mode: 'default development/watch build', nodeEnv: undefined, tsupMode: undefined },
    {
      mode: 'development script overriding NODE_ENV',
      nodeEnv: 'production',
      tsupMode: 'development',
    },
  ])(
    'isolates the CLI and library for $mode',
    async ({ nodeEnv, tsupMode }) => {
      const [productionCli] = await configuredOutputs('production');
      const outputs = await configuredOutputs(nodeEnv, tsupMode);
      const cli = outputs.filter((output) => isDeepStrictEqual(output.entry, productionCli?.entry));
      const library = outputs.filter(
        (output) => !isDeepStrictEqual(output.entry, productionCli?.entry),
      );

      expect(cli).toHaveLength(1);
      expect(cli[0]?.outDir).toBe('dist-dev/bin');
      expect(library).toHaveLength(1);
      expect(library[0]?.outDir).toBe('dist-dev');
    },
    30_000,
  );

  it.each(['production', 'development'])(
    'keeps an explicit standalone preview separate in %s mode',
    async (mode) => {
      const directory = resolve('.local-test-tmp', 'preview with spaces');
      const outputs = await configuredOutputs(undefined, mode, directory);

      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.outDir).toBe(join(directory, 'bin'));
    },
  );

  it('honors a relative preview directory', async () => {
    const directory = join('.local-test-tmp', 'relative-preview');
    const outputs = await configuredOutputs('production', 'development', directory);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.outDir).toBe(join(directory, 'bin'));
  });

  it('treats an empty preview override as the default development directory', async () => {
    const outputs = await configuredOutputs(undefined, 'development', '');

    expect(outputs.map((output) => output.outDir)).toEqual(['dist-dev/bin', 'dist-dev']);
  });
});

it('post-processes and smoke-tests only the selected standalone build directory', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temporaryRoot = join(root, '.local-test-tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'build-isolation-'));
  try {
    const output = join(directory, 'custom preview with spaces');
    const normalOutput = join(directory, 'dist');
    mkdirSync(join(normalOutput, 'bin'), { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'build-isolation-fixture', version: '1.0.0', dependencies: {} }),
    );
    const previousArtifact = 'console.log("existing-release-must-stay-unchanged");\n';
    writeFileSync(join(normalOutput, 'bin/qianwen.js'), previousArtifact);
    writeFileSync(join(normalOutput, 'preserve.map'), 'existing release sourcemap');
    const preload = join(directory, 'fake-compiler.mjs');
    writeFileSync(
      preload,
      `import { mkdirSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (args[0] !== process.env.QIANWEN_TEST_TSUP_ENTRY) return original(command, args, options);
  const output = process.env.QIANWEN_BUILD_OUTDIR;
  mkdirSync(join(output, 'bin'), { recursive: true });
  writeFileSync(join(output, 'bin/qianwen.js'), 'const selectedArtifact = "selected-output-smoke"; console.log(selectedArtifact);\\n');
  writeFileSync(join(output, 'remove.map'), 'stale preview sourcemap');
  writeFileSync(join(output, 'bin/metafile-esm.json'), JSON.stringify({ inputs: { 'fixture.ts': { bytes: 80 } } }));
  return { status: 0, signal: null, stdout: '', stderr: '' };
};
globalThis.fetch = async () => { throw new Error('Build verification must not access the network'); };
syncBuiltinESMExports();
`,
    );
    const require = createRequire(import.meta.url);
    const tsupPackagePath = require.resolve('tsup/package.json');
    const metadata = JSON.parse(readFileSync(tsupPackagePath, 'utf8'));
    const tsupEntry = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.tsup;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        require.resolve('tsx'),
        join(root, 'scripts/build.ts'),
        '--mode',
        'prod',
        '--analyze',
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          QIANWEN_BUILD_OUTDIR: output,
          QIANWEN_TEST_TSUP_ENTRY: resolve(dirname(tsupPackagePath), tsupEntry),
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(normalOutput, 'bin/qianwen.js'), 'utf8')).toBe(previousArtifact);
    expect(readFileSync(join(normalOutput, 'preserve.map'), 'utf8')).toBe(
      'existing release sourcemap',
    );
    expect(() => readFileSync(join(output, 'remove.map'))).toThrow();
    expect(readFileSync(join(output, 'bin/qianwen.js'), 'utf8')).not.toContain('selectedArtifact');
    expect(result.stdout).toContain('fixture.ts');
    expect(result.stdout).toContain('Smoke test passed: selected-output-smoke');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
