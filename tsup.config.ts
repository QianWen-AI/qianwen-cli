import { defineConfig, type Format, type Options } from 'tsup';
import { readFileSync } from 'fs';
import { join } from 'path';

export default defineConfig(() => {
  // ── Build mode ────────────────────────────────────────────────────────────────
  // Controlled by NODE_ENV or the TSUP_MODE env var set by scripts/build.ts.
  // prod: minify + treeshake + metafile (sourcemap disabled by default, enable with --sourcemap)
  // dev:  no minify, inline sourcemap for fast iteration
  const isProd = (process.env.TSUP_MODE ?? process.env.NODE_ENV) === 'production';

  // Source map: disabled by default in prod to prevent .map files from leaking into
  // published packages. Enable explicitly via TSUP_SOURCEMAP=1 (set by --sourcemap flag).
  const enableSourcemap = process.env.TSUP_SOURCEMAP === '1';

  // ── Version injection ─────────────────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
    version: string;
  };
  const buildTime = new Date().toISOString();
  // A development watcher and local preview must not overwrite release artifacts.
  const buildOutDir = process.env.QIANWEN_BUILD_OUTDIR || (isProd ? 'dist' : 'dist-dev');
  const standalonePreview = Boolean(process.env.QIANWEN_BUILD_OUTDIR);
  const runtimeDependencies: NonNullable<Options['esbuildPlugins']> = standalonePreview
    ? [
        {
          name: 'standalone-runtime-dependencies',
          setup(build) {
            build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
              path: 'react-devtools-core',
              namespace: 'optional-devtools',
            }));
            build.onLoad({ filter: /.*/, namespace: 'optional-devtools' }, () => ({
              contents: 'export default { connectToDevTools() {} };',
              loader: 'js',
            }));
          },
        },
      ]
    : [];

  const defines: Record<string, string> = {
    __VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __NODE_ENV__: JSON.stringify(isProd ? 'production' : 'development'),
    __ERROR_VERBOSITY__: JSON.stringify(process.env.BUILD_ERROR_VERBOSITY ?? 'graceful'),
    // Proxy build variant gate (scripts/build.ts --allow-proxy). Default false:
    // the undici branch in base-client.ts is constant-folded and treeshaken away.
    __ALLOW_PROXY__: JSON.stringify(process.env.BUILD_ALLOW_PROXY === '1'),
  };

  // ── Shared base options ───────────────────────────────────────────────────────
  const base = {
    format: ['esm'] as Format[],
    target: 'node18' as const,
    shims: true,
    external: standalonePreview ? [] : ['react', 'ink', 'chalk', 'commander', 'qrcode-generator'],
    noExternal: standalonePreview ? [/.*/] : undefined,
    esbuildPlugins: runtimeDependencies,
    // Proxy variant only: undici is inlined as CJS and calls require() on node
    // builtins at module evaluation; esbuild's ESM require shim rejects that
    // ("Dynamic require of 'assert' is not supported"), so provide a real
    // createRequire. Kept out of default builds to preserve the default bundle baseline.
    ...(process.env.BUILD_ALLOW_PROXY === '1' || standalonePreview
      ? {
          banner: {
            js: "import { createRequire as __qianwenBundleRequire } from 'module'; const require = __qianwenBundleRequire(import.meta.url);",
          },
        }
      : {}),
    // Production: compress identifiers + whitespace + syntax
    // Development: no minify, inline sourcemap for debuggability
    minify: isProd,
    treeshake: isProd,
    // Prod: sourcemap disabled by default (prevent .map leaking); enable with --sourcemap
    // Dev: inline sourcemap for debuggability
    sourcemap: (isProd ? (enableSourcemap ? true : false) : 'inline') as boolean | 'inline',
    // Output bundle analysis metadata (only in prod; consumed by --analyze flag)
    metafile: isProd,
    define: defines,
  };

  return [
    // ── Entry-point binary (target-aware) ───────────────────────────────────────
    {
      ...base,
      entry: ['bin/qianwen.ts'],
      outDir: join(buildOutDir, 'bin'),
      dts: !isProd && !standalonePreview, // Skip type declarations in prod mode (not needed for CLI)
      clean: true,
      splitting: false,
    },
    // ── Library exports (index, cli, repl) ─────────────────────────────────────
    // Only built in dev mode. The CLI binary (bin/cli.ts) already inlines
    // all business code via esbuild bundling, so these library exports are only
    // needed for external integration / development.
    ...(!isProd && !standalonePreview
      ? [
          {
            ...base,
            entry: ['src/index.ts', 'src/cli.ts', 'src/repl.ts'],
            outDir: buildOutDir,
            dts: true,
            clean: false,
            splitting: false,
          },
        ]
      : []),
  ];
});
