/**
 * Generate and statically validate a local `.mjs` plugin without network access
 * or changes to install state.
 * Exit codes: 1 = target already a plugin (no --force) / invalid name / usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { resolveFormatFromCommand, outputJSON } from '../../output/format.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { isSafePackageName } from '../../plugins/installer.js';
import { normalizeCommandName } from '../../plugins/loader.js';
import { runPluginValidateChecks } from '../../plugins/validate.js';
import { handleError, invalidArgError, HandledError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { formatCmd } from '../../utils/runtime-mode.js';
import { expandHomePath } from '../../utils/expand-home.js';

type Format = 'json' | 'text' | 'table';

/** Derive a safe npm name from a directory basename (lowercased, sanitized). */
function deriveName(dir: string): string {
  const base = path.basename(path.resolve(dir)).toLowerCase();
  const cleaned = base.replace(/[^a-z0-9._-]/g, '-').replace(/^[-_.]+/, '');
  return cleaned || 'my-qianwen-plugin';
}

/** Derive a command name from an npm name (last path segment of a scope). */
function deriveCommand(name: string): string {
  const last = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return normalizeCommandName(last) || 'hello';
}

function packageJsonTemplate(name: string, command: string): string {
  const manifest = {
    name,
    version: '0.1.0',
    description: `${command} — a QianWen CLI plugin`,
    type: 'module',
    main: './index.mjs',
    license: 'MIT',
    qianwen: {
      command,
      category: 'Plugins',
      subcommands: [
        {
          command: 'hello [name]',
          description: 'Say hello (edit me)',
          handlerKey: 'hello',
          options: [{ flag: '--format <fmt>', description: 'Output format: table, json, text' }],
        },
      ],
    },
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

const INDEX_TEMPLATE = `/**
 * Export handlers keyed by each leaf command's \`handlerKey\` in package.json's
 * \`qianwen\` field.
 * The CLI calls handlers[handlerKey](ctx, opts, positional).
 *
 * ctx.config contains CLI settings without credentials or services.
 * ctx.directory is the invocation cwd; ctx.abort is an AbortSignal for timeout/cancellation.
 * Pass ctx.abort to async work.
 * ctx.callOpenApi(product, action, params) uses host login and a fixed gateway.
 * No API declaration is required; the backend decides access.
 * Only explicit public pairs allow anonymous calls; others require login.
 * It returns raw API response data. Calls may write without automatic retries
 * or transaction confirmations. Cancellation does not prove the server did not execute.
 *
 * opts contains parsed options; positional is an array of positional arguments.
 * Emit structured JSON for --format json and plain text otherwise.
 */

function resolveFormat(opts) {
  const f = opts?.format;
  return f === 'json' || f === 'text' || f === 'table' ? f : 'text';
}

export const handlers = {
  hello: async (ctx, opts, positional) => {
    const name = positional[0] ?? 'world';
    const message = \`Hello, \${name}!\`;
    if (resolveFormat(opts) === 'json') {
      process.stdout.write(JSON.stringify({ greeting: message, name }) + '\\n');
      return;
    }
    process.stdout.write(message + '\\n');
  },
};
`;

function readmeTemplate(name: string, command: string): string {
  return `# ${name}

A QianWen CLI plugin. Scaffolded by \`qianwen plugin init\`.

## Develop

\`\`\`bash
# Validate the manifest (static, no install):
qianwen plugin validate .

# Install locally to test (copies into ~/.qianwen/plugins/):
qianwen plugin install .

# Run your command:
qianwen ${command} hello Alice
qianwen ${command} hello Alice --format json
\`\`\`

Edit \`index.mjs\` (the \`handlers\` object) and the \`qianwen\` field in
\`package.json\` (the command tree). Re-run \`plugin install .\` after changes.

## Anatomy

- \`package.json\` — the \`qianwen\` field declares the command tree.
- \`index.mjs\` — \`export const handlers = { hello }\` (handler addressing).
`;
}

export function pluginInitAction(cmd: Command): (...args: any[]) => void | Promise<void> {
  return async function (this: Command, dirArg?: string) {
    const self = this ?? cmd;
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(self, config) as Format;
    try {
      const opts = self.opts() as { name?: string; command?: string; force?: boolean };
      const dir = path.resolve(expandHomePath(dirArg ?? '.'));
      const name = opts.name ?? deriveName(dir);

      if (!isSafePackageName(name)) {
        const message = `"${name}" is not a valid npm package name. Pass --name <pkg>.`;
        if (format === 'json') handleError(invalidArgError(message), format);
        process.stderr.write(message + '\n');
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
        return;
      }
      const command = normalizeCommandName(opts.command ?? deriveCommand(name));
      if (!command) {
        throw invalidArgError('Plugin command must not be empty. Pass --command <cmd>.');
      }

      const files = {
        'package.json': packageJsonTemplate(name, command),
        'index.mjs': INDEX_TEMPLATE,
        'README.md': readmeTemplate(name, command),
      };
      const existing = Object.keys(files).filter((file) => fs.existsSync(path.join(dir, file)));
      if (existing.length > 0 && !opts.force) {
        const message = `${existing.join(', ')} already exist in ${dir}. Use --force to overwrite package.json while preserving source and documentation, or pick an empty directory.`;
        if (format === 'json') handleError(invalidArgError(message), format);
        process.stderr.write(message + '\n');
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
        return;
      }

      fs.mkdirSync(dir, { recursive: true });
      const written: string[] = [];
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(dir, file);
        if (file !== 'package.json' && fs.existsSync(target)) continue;
        fs.writeFileSync(target, content, 'utf8');
        written.push(target);
      }

      const checks = runPluginValidateChecks(dir, new Set(), []);
      const selfCheckOk = checks.every((c) => c.status !== 'fail');
      if (!selfCheckOk) {
        throw invalidArgError(
          `Plugin scaffold validation failed: ${checks
            .filter((check) => check.status === 'fail')
            .map((check) => check.detail)
            .join('; ')}`,
        );
      }
      const warnings =
        opts.force && existing.includes('index.mjs')
          ? [
              'Existing index.mjs was preserved. Static validation does not verify that its exported handlers match the regenerated package.json; run the plugin commands after installation.',
            ]
          : [];

      const nextSteps = [
        `cd ${dir}`,
        formatCmd('plugin validate .'),
        formatCmd('plugin install .'),
      ];
      if (format === 'json') {
        outputJSON({ created: written, name, command, selfCheckOk, warnings, nextSteps });
        return;
      }
      process.stdout.write(`Created plugin "${name}" (command: ${command}) in ${dir}\n`);
      for (const f of written) process.stdout.write(`  + ${path.relative(dir, f)}\n`);
      for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
      process.stdout.write(`\nNext:\n`);
      for (const s of nextSteps) process.stdout.write(`  ${s}\n`);
    } catch (err) {
      // A guard above may have called handleError (which throws HandledError) in
      // json mode — it's already rendered, so re-throw instead of rendering twice.
      if (err instanceof HandledError) throw err;
      handleError(err, format);
      process.exitCode = EXIT_CODES.GENERAL_ERROR;
    }
  };
}

export function registerPluginInitCommand(parent: Command): Command {
  const init = parent
    .command('init [dir]')
    .description('Scaffold a new local plugin skeleton')
    .option('--name <pkg>', 'npm package name (default: derived from dir)')
    .option('--command <cmd>', 'top-level command name (default: derived from name)')
    .option('--force', 'overwrite package.json while preserving existing source and README files')
    .option('--format <fmt>', 'Output format: table, json, text (default: auto)');
  init.action(pluginInitAction(init));
  return init;
}
