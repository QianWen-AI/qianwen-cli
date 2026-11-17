import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { installLocalPlugin } from '../../src/plugins/installer.js';
import { registerPluginCommands } from '../../src/plugins/loader.js';
import { runPluginValidateChecks } from '../../src/plugins/validate.js';

vi.mock('../../src/config/manager.js', () => ({ getEffectiveConfig: () => ({}) }));
let root: string;
let source: string;
const manifest = { command: 'demo', entry: './entry.mjs', handlerKey: 'run' };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.plugin-hardening-'));
  source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', qianwen: manifest }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(root, { recursive: true, force: true });
});

it('excludes dependency and git directories from local copies', () => {
  for (const name of ['node_modules', '.git']) {
    fs.mkdirSync(path.join(source, name));
    fs.writeFileSync(path.join(source, name, 'ignored'), 'ignored');
  }
  fs.writeFileSync(path.join(source, 'entry.mjs'), 'export const handlers = {};');
  const result = installLocalPlugin(source, path.join(root, 'plugins'));
  expect(result.ok).toBe(true);
  const dest = path.join(root, 'plugins/node_modules/demo');
  expect(fs.existsSync(path.join(dest, 'entry.mjs'))).toBe(true);
  expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false);
  expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
});

it('rejects oversized sparse files before copying and preserves the existing install', () => {
  const plugins = path.join(root, 'plugins');
  const dest = path.join(plugins, 'node_modules/demo');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'keep'), 'existing');
  const large = path.join(source, 'large');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, 101 * 1024 * 1024);
  expect(installLocalPlugin(source, plugins)).toMatchObject({
    ok: false,
    error: expect.stringContaining('copy limit'),
  });
  expect(fs.readFileSync(path.join(dest, 'keep'), 'utf8')).toBe('existing');
  expect(fs.readdirSync(path.dirname(dest))).toEqual(['demo']);
});

it('rejects symlink entry escapes in both validation and execution', async () => {
  const outside = path.join(root, 'outside.mjs');
  fs.writeFileSync(outside, 'throw new Error("outside code executed");');
  fs.symlinkSync(outside, path.join(source, 'entry.mjs'));
  expect(runPluginValidateChecks(source, new Set(), [])).toContainEqual(
    expect.objectContaining({ name: 'entry-file', status: 'fail' }),
  );
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const program = new Command().exitOverride();
  registerPluginCommands(program, [{ name: 'demo', pkgDir: source, manifest }]);
  await program.parseAsync(['demo'], { from: 'user' }).catch(() => {});
  const output = stderr.mock.calls.flat().join('');
  expect(output).toContain('escapes the package directory');
  expect(output).not.toContain('outside code executed');
});
