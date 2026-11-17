import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadInstalledPlugins, registerPluginCommands } from '../../src/plugins/loader.js';

vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));

let root: string;
let pluginsDir: string;
let manifestPath: string;
let warnings: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.plugin-metadata-'));
  pluginsDir = path.join(root, 'plugins');
  manifestPath = path.join(root, 'plugins.json');
  warnings = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function writePackage(name: string, metadata: Record<string, unknown> = {}): string {
  const pkgDir = path.join(pluginsDir, 'node_modules', name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      qianwen: { command: name, entry: './entry.mjs', handlerKey: 'run', auth: 'optional' },
      ...metadata,
    }),
  );
  fs.writeFileSync(
    path.join(pkgDir, 'entry.mjs'),
    `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(root, `${name}-imported`))}, 'unexpected import');
export const handlers = { run: async () => {} };
`,
  );
  return pkgDir;
}

describe('external metadata failures are isolated', () => {
  it.each(['engines', 'peerDependencies'] as const)(
    'skips malformed %s metadata, warns and registers a healthy sibling without importing entries',
    (field) => {
      writePackage('metadata-broken', { [field]: { '@qianwenai/qianwen-cli': 42 } });
      const goodDir = writePackage('metadata-healthy');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          plugins: ['metadata-broken', 'metadata-healthy'].map((name) => ({
            name,
            version: '1.0.0',
            enabled: true,
            source: 'npm',
          })),
        }),
      );

      const plugins = loadInstalledPlugins(manifestPath, pluginsDir);
      const program = new Command();
      registerPluginCommands(program, plugins);

      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({ name: 'metadata-healthy', pkgDir: goodDir });
      expect(program.commands.map((command) => command.name())).toEqual(['metadata-healthy']);
      expect(warnings.join('')).toContain('metadata-broken');
      expect(warnings.join('')).not.toMatch(/\n\s+at\s/);
      expect(fs.existsSync(path.join(root, 'metadata-broken-imported'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'metadata-healthy-imported'))).toBe(false);
    },
  );
});
