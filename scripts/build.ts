#!/usr/bin/env tsx
/**
 * Production build orchestrator for qianwen-cli.
 *
 * Usage:
 *   tsx scripts/build.ts                        # production build (default, Terser obfuscation)
 *   tsx scripts/build.ts --mode dev             # development build (no minify)
 *   tsx scripts/build.ts --mode prod            # production build (Terser obfuscation)
 *   tsx scripts/build.ts --obfuscator terser    # production build with Terser obfuscation (default)
 *   tsx scripts/build.ts --obfuscator none      # production build without obfuscation
 *   tsx scripts/build.ts --sourcemap            # enable source map generation (disabled by default in prod)
 *   tsx scripts/build.ts --analyze              # production build + bundle analysis
 *   tsx scripts/build.ts --skip-smoke           # skip smoke test
 *   tsx scripts/build.ts --skip-obfuscate       # skip obfuscation step (legacy, same as --obfuscator none)
 */

import { spawnSync } from 'child_process';
import { statSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, relative } from 'path';

// ── CLI argument parsing ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const mode = (() => {
  const idx = argv.indexOf('--mode');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1] as 'dev' | 'prod';
  return 'prod';
})();
const analyze = argv.includes('--analyze');
const skipSmoke = argv.includes('--skip-smoke');
const skipObfuscate = argv.includes('--skip-obfuscate');
const isProd = mode === 'prod';

// Obfuscator selection: 'none' | 'terser' | 'jso' (javascript-obfuscator)
// --obfuscator <type> takes precedence; --skip-obfuscate is a legacy alias for --obfuscator none.
// Default for prod builds: 'terser'.
const obfuscator = (() => {
  const idx = argv.indexOf('--obfuscator');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1] as 'none' | 'terser';
  if (skipObfuscate) return 'none';
  return 'terser';
})();

// Error verbosity: 'suppress' | 'graceful' | 'verbose'
// Controls how API errors are displayed. Default: 'graceful' (user-friendly messages).
const errorVerbosity = (() => {
  const idx = argv.indexOf('--error-verbosity');
  if (idx !== -1 && argv[idx + 1]) {
    const val = argv[idx + 1];
    if (!['suppress', 'graceful', 'verbose'].includes(val)) {
      console.error(`Invalid --error-verbosity '${val}'. Supported: suppress, graceful, verbose`);
      process.exit(1);
    }
    return val as 'suppress' | 'graceful' | 'verbose';
  }
  return 'graceful';
})();

// Source map control: disabled by default in prod to prevent .map files from leaking.
// Use --sourcemap to explicitly enable source map generation.
const enableSourcemap = argv.includes('--sourcemap');

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function collectDistFiles(dir: string): Array<{ path: string; size: number }> {
  const results: Array<{ path: string; size: number }> = [];
  if (!existsSync(dir)) return results;

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
        results.push({ path: relative(process.cwd(), full), size: statSync(full).size });
      }
    }
  }
  walk(dir);
  return results.sort((a, b) => b.size - a.size);
}

// ── Banner ────────────────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};

console.log('');
console.log(`  QianWen CLI build`);
console.log(`  version  : ${pkg.version}`);
console.log(
  `  mode     : ${mode}${isProd ? ' (minify + treeshake)' : ' (no minify, inline sourcemap)'}`,
);
console.log(`  obfuscator : ${isProd ? obfuscator : 'n/a'}`);
console.log(`  sourcemap  : ${isProd ? (enableSourcemap ? 'yes (linked)' : 'no') : 'inline'}`);
console.log(`  analyze  : ${analyze}`);
console.log('');

// ── Build ─────────────────────────────────────────────────────────────────────

const start = Date.now();

const env: NodeJS.ProcessEnv = {
  ...process.env,
  TSUP_MODE: isProd ? 'production' : 'development',
  TSUP_SOURCEMAP: enableSourcemap ? '1' : '',
  BUILD_ERROR_VERBOSITY: errorVerbosity,
};

console.log('  Building...');
const result = spawnSync('pnpm', ['exec', 'tsup'], {
  env,
  stdio: 'inherit',
  shell: false,
});

if (result.status !== 0) {
  console.error('\n  Build failed.');
  process.exit(result.status ?? 1);
}

const elapsed = Date.now() - start;

// ── Clean up .map files when sourcemap is disabled ────────────────────────────
// tsup may leave stale .map files from previous builds (especially in dist/
// where clean: false). When sourcemap is not requested, remove all .map files
// to prevent them from leaking into published packages.
if (isProd && !enableSourcemap) {
  const distDir = join(process.cwd(), 'dist');
  if (existsSync(distDir)) {
    function removeMapFiles(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          removeMapFiles(full);
        } else if (entry.isFile() && entry.name.endsWith('.map')) {
          unlinkSync(full);
        }
      }
    }
    removeMapFiles(distDir);
  }
}

// ── Build summary ─────────────────────────────────────────────────────────────
// Extra blank line to visually separate tsup's output from our summary,
// since tsup does not guarantee a trailing newline on its last log line.

console.log('');
console.log('');
console.log('  Build summary');
console.log('  ─────────────────────────────────────────────');

const distFiles = collectDistFiles(join(process.cwd(), 'dist'));
let totalSize = 0;
for (const f of distFiles) {
  totalSize += f.size;
  const label = f.path.padEnd(45);
  console.log(`  ${label}  ${formatBytes(f.size)}`);
}
console.log('  ─────────────────────────────────────────────');
console.log(`  Total JS+DTS size : ${formatBytes(totalSize)}`);
console.log(`  Build time        : ${formatMs(elapsed)}`);
console.log('');

// ── Bundle analysis ───────────────────────────────────────────────────────────

if (analyze && isProd) {
  const metaFiles = [
    join(process.cwd(), 'dist', 'bin', 'metafile-esm.json'),
    join(process.cwd(), 'dist', 'metafile-esm.json'),
  ].filter(existsSync);

  if (metaFiles.length > 0) {
    console.log('  Bundle analysis (top inputs by size):');
    console.log('  ─────────────────────────────────────────────');
    for (const metaPath of metaFiles) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
        inputs: Record<string, { bytes: number }>;
      };
      const inputs = Object.entries(meta.inputs)
        .sort(([, a], [, b]) => b.bytes - a.bytes)
        .slice(0, 15);
      console.log(`  [${relative(process.cwd(), metaPath)}]`);
      for (const [path, { bytes }] of inputs) {
        const label = path
          .replace(/^node_modules\//, '~nm/')
          .slice(0, 50)
          .padEnd(52);
        console.log(`    ${label}  ${formatBytes(bytes)}`);
      }
    }
    console.log('');
  } else {
    console.log('  No metafile found. Ensure tsup.config.ts has metafile: true for prod builds.');
  }
}

// ── Terser obfuscation (prod only) ────────────────────────────────────────────
// Runs Terser on the compiled binary after esbuild minify.
// Pipeline: tsup (esbuild minify) → Terser (deep compress + mangle) → Smoke test
//
// Terser provides a middle ground between esbuild-only and javascript-obfuscator:
//   - More aggressive dead-code elimination, constant folding, and inlining
//   - Property name mangling (underscore-prefixed properties only, safe strategy)
//   - Multi-pass compression for maximum size reduction
//   - No string encryption or self-defending (use jso for those)

if (isProd && obfuscator === 'terser') {
  const binPath = join(process.cwd(), 'dist', 'bin', 'qianwen.js');
  if (existsSync(binPath)) {
    console.log('  Obfuscating with Terser...');
    const terserStart = Date.now();

    // Dynamic import so the dep is only loaded when needed
    const { minify } = await import('terser');

    const source = readFileSync(binPath, 'utf-8');

    const result = await minify(source, {
      // ── Parse as ESM (required for top-level await support) ────────────────
      module: true,
      // ── Compression ────────────────────────────────────────────────────────
      compress: {
        passes: 3, // Multi-pass for more aggressive optimizations
        drop_console: false, // CLI tool needs console output
        drop_debugger: true, // Remove debugger statements
        pure_getters: true, // Assume property access has no side effects
        unsafe_math: false, // No unsafe math optimizations
        ecma: 2020, // Target ES2020 (Node 18+)
        toplevel: true, // Allow top-level scope optimizations
        module: true, // ESM mode
      },
      // ── Identifier mangling ────────────────────────────────────────────────
      mangle: {
        toplevel: true, // Mangle top-level variable names
        properties: {
          regex: /^_/, // Only mangle underscore-prefixed properties (safe)
        },
      },
      // ── Output format ──────────────────────────────────────────────────────
      format: {
        comments: false, // Remove all comments
        ecma: 2020,
      },
      // ── Source map ─────────────────────────────────────────────────────────
      sourceMap: false, // No source map for Terser stage
    });

    if (result.code) {
      writeFileSync(binPath, result.code, 'utf-8');
    }

    const terserSize = statSync(binPath).size;
    const terserElapsed = Date.now() - terserStart;
    console.log(`  Terser done       : ${formatBytes(terserSize)} (${formatMs(terserElapsed)})`);
    console.log('');
  }
}

// ── Smoke test ────────────────────────────────────────────────────────────────

if (!skipSmoke) {
  const binary = join(process.cwd(), 'dist', 'bin', 'qianwen.js');
  if (!existsSync(binary)) {
    console.error(`  Smoke test failed: binary not found at ${binary}`);
    process.exit(1);
  }

  console.log('  Running smoke test...');
  const smoke = spawnSync(process.execPath, [binary, '--version'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });

  if (smoke.status !== 0 || smoke.error) {
    console.error('  Smoke test FAILED:');
    console.error(smoke.stderr || smoke.error?.message);
    process.exit(1);
  }

  const versionOutput = smoke.stdout.trim();
  console.log(`  Smoke test passed: ${versionOutput}`);
  console.log('');
}

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(`  Done in ${formatMs(elapsed)}`);
console.log('');
