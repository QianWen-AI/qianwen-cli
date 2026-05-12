import { defineConfig, type Format } from 'tsup';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Build mode ────────────────────────────────────────────────────────────────
// Controlled by NODE_ENV or the TSUP_MODE env var set by scripts/build.ts.
// prod: minify + treeshake + metafile (sourcemap disabled by default, enable with --sourcemap)
// dev:  no minify, inline sourcemap for fast iteration
const isProd = (process.env.TSUP_MODE ?? process.env.NODE_ENV) === 'production';

// Source map: disabled by default in prod to prevent .map files from leaking into
// published packages. Enable explicitly via TSUP_SOURCEMAP=1 (set by --sourcemap flag).
const enableSourcemap = process.env.TSUP_SOURCEMAP === '1';

// ── Version injection ─────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
const buildTime = new Date().toISOString();

const defines: Record<string, string> = {
  __VERSION__: JSON.stringify(pkg.version),
  __BUILD_TIME__: JSON.stringify(buildTime),
  __NODE_ENV__: JSON.stringify(isProd ? 'production' : 'development'),
  __ERROR_VERBOSITY__: JSON.stringify(process.env.BUILD_ERROR_VERBOSITY ?? 'graceful'),
};

// ── Shared base options ───────────────────────────────────────────────────────
const base = {
  format: ['esm'] as Format[],
  target: 'node18' as const,
  shims: true,
  external: ['react', 'ink', 'chalk', 'commander'],
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

export default defineConfig([
  // ── Entry-point binary (target-aware) ───────────────────────────────────────
  {
    ...base,
    entry: ['bin/qianwen.ts'],
    outDir: 'dist/bin',
    dts: !isProd,  // Skip type declarations in prod mode (not needed for CLI)
    clean: true,
    splitting: false,
  },
  // ── Library exports (index, cli, repl) ─────────────────────────────────────
  // Only built in dev mode. The CLI binary (bin/cli.ts) already inlines
  // all business code via esbuild bundling, so these library exports are only
  // needed for external integration / development.
  ...(!isProd ? [{
    ...base,
    entry: ['src/index.ts', 'src/cli.ts', 'src/repl.ts'],
    outDir: 'dist',
    dts: true,
    clean: false,
    splitting: false,
  }] : []),
]);
