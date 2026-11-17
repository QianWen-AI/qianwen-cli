import { Command, type Option, type Argument } from 'commander';
import { join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { EventEmitter } from 'node:events';
import {
  setCommandHelpMetadata,
  addExamples,
  setLongDescription,
} from '../utils/commander-helpers.js';
import { getEffectiveConfig } from '../config/manager.js';
import type { ConfigSchema } from '../types/config.js';
import { createApiClient } from '../api/api-client.js';
import { assertOpenApiAccess } from '../api/openapi-access.js';
import { setOpenApiPolicyReservedNames } from '../config/openapi-policy.js';
import { handleError, CliError, HandledError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { isRealPathWithinBase, resolveWithinBase } from '../utils/path-safety.js';
import { resolveFormatFromCommand } from '../output/format.js';
import { ensureAuthenticated } from '../auth/credentials.js';
import { VERSION } from '../version.js';
import { getPluginsDir, getPluginsManifestPath } from '../config/paths.js';
import { ensureDefaultPlugin, readUsableDefaultPlugin } from './default-install.js';
import { hasPendingPluginInstall } from './install-transaction.js';
import { site } from '../site.js';
import { formatCmd, isReplMode } from '../utils/runtime-mode.js';
import { createPluginExecution, pluginErrors, normalizePluginError } from './runtime.js';
import { getDefaultPlugins, getDefaultPlugin, type DefaultPlugin } from './defaults.js';
import { isHelpInvocation } from '../utils/cli-help.js';
import { registerCommandInterrupt } from '../utils/command-interrupt.js';
import { collectReservedNames, pluginNames, resolvePluginConflict } from './names.js';
export {
  collectReservedNames,
  pluginNames,
  normalizeCommandName,
  resolvePluginConflict,
  classifyInstallCollision,
} from './names.js';
import type { PluginDescriptor } from './descriptor.js';
import { configurePluginCommand } from './command-tree.js';
import { isCliVersionCompatible, isValidPluginVersion } from './compatibility.js';
import {
  readInstalledManifest,
  readPluginPackageManifest,
  validateManifest,
  type PluginManifest,
  type PluginCommandNode,
} from './manifest.js';

export interface LoadablePlugin {
  name: string;
  version?: string;
  pkgDir: string;
  manifest: PluginManifest;
}

/** New config keys require an explicit decision before being handed to plugins. */
function sanitizeConfigForPlugin(config: ConfigSchema): ConfigSchema {
  return {
    'output.format': config['output.format'],
    'api.endpoint': config['api.endpoint'],
    'auth.endpoint': config['auth.endpoint'],
    'cache.ttl': config['cache.ttl'],
    'support.categorySource': config['support.categorySource'],
    'model.endpoint': config['model.endpoint'],
    'model.api_key': '',
  };
}

export interface PluginContext {
  /**
   * Explicit non-secret CLI config fields; `model.api_key` stays blank for
   * compatibility and unknown keys are omitted. Use `callOpenApi` for auth.
   */
  config: ConfigSchema;
  format: 'json' | 'text' | 'table';
  runtime: { cliVersion: string; language: string; isRepl: boolean };
  errors: typeof pluginErrors;
  terminal: { withInput<T>(operation: () => Promise<T>): Promise<T> };
  /** Project directory the command runs in. Plugins should prefer this over process.cwd(). */
  directory: string;
  /**
   * Aborts when the command is cancelled or its execution deadline is exceeded. Plugins
   * doing their own async work should honor it (pass to fetch, check .aborted);
   * the kernel aborts it on timeout so a hung plugin can't wedge the command.
   */
  abort: AbortSignal;
  /**
   * OpenAPI proxy with host credentials and a fixed gateway. The backend decides
   * admission. Only configured public pairs allow anonymous requests. Returns
   * raw Type A data; writes are not retried and cancellation does not undo them.
   */
  callOpenApi(product: string, action: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type PluginHandler = (ctx: PluginContext, opts: unknown, args: unknown[]) => unknown;

/** Keep host credentials private. */
function makeCallOpenApi(signal: AbortSignal): PluginContext['callOpenApi'] {
  const apiClient = createApiClient();
  return async (product, action, params) => {
    const policy = assertOpenApiAccess({ product, action, params, signal });
    return apiClient.callFlatApi({
      product,
      action,
      params,
      signal,
      authOptional: policy.authOptional,
    });
  };
}

const PLUGIN_TIMEOUT_MS = 60_000;
const DEFAULT_PLUGIN_TIMEOUT_MS = 180_000;
const loadedPluginNames = new Set<string>();

export function hasLoadedPluginCode(name: string): boolean {
  return loadedPluginNames.has(name);
}

function warn(message: string): void {
  process.stderr.write(`qianwen: plugin ${message}\n`);
}

function diskModuleLoader(plugin: LoadablePlugin): PluginDescriptor['loadHandlers'] {
  return async () => {
    const entry = plugin.manifest.entry as string;
    const lexicalPath = resolveWithinBase(plugin.pkgDir, entry);
    const entryPath =
      lexicalPath && existsSync(lexicalPath)
        ? resolveWithinBase(realpathSync(plugin.pkgDir), realpathSync(lexicalPath))
        : lexicalPath;
    if (!entryPath) {
      throw new CliError({
        code: 'PLUGIN_LOAD_FAILED',
        message: `plugin entry "${entry}" escapes the package directory`,
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }
    const url = pathToFileURL(entryPath);
    if (plugin.version) url.searchParams.set('version', plugin.version);
    // Failed evaluation can leave the entry or its dependencies cached.
    loadedPluginNames.add(plugin.name);
    return import(url.href) as ReturnType<PluginDescriptor['loadHandlers']>;
  };
}

function buildStub(
  parent: Command,
  node: PluginCommandNode,
  loadHandlers: PluginDescriptor['loadHandlers'],
  timeoutMs: number,
  trustedDefault: boolean,
  inheritedAuth?: PluginCommandNode['auth'],
  existing?: Command,
): Command {
  const cmd = existing ?? parent.command(node.command);
  if (existing) {
    for (const option of cmd.options) {
      (cmd as unknown as EventEmitter).removeAllListeners(`option:${option.name()}`);
      cmd.setOptionValue(option.attributeName(), undefined);
    }
    (cmd.commands as Command[]).splice(0);
    (cmd.options as Option[]).splice(0);
    (cmd.registeredArguments as Argument[]).splice(0);
    cmd.aliases().splice(0);
    cmd.description('').allowUnknownOption(false).allowExcessArguments(false);
    cmd.arguments(node.command.trim().split(/\s+/).slice(1).join(' '));
    setLongDescription(cmd, node.longDescription ?? '');
    addExamples(cmd, []);
  }
  configurePluginCommand(cmd, node);
  const auth = node.auth ?? inheritedAuth;
  const budget = node.timeoutMs ?? timeoutMs;
  if (node.subcommands?.length) {
    for (const sub of node.subcommands)
      buildStub(cmd, sub, loadHandlers, budget, trustedDefault, auth);
    cmd.helpCommand(
      !cmd.commands.some((child) => pluginNames(child.name(), child.aliases()).includes('help')),
    );
    cmd.action(() => {
      cmd.outputHelp();
      process.stdout.write('\n');
    });
    return cmd;
  }
  cmd.helpCommand(false);
  const handlerKey = node.handlerKey;
  cmd.action(async (...actionArgs: unknown[]) => {
    const config = getEffectiveConfig();
    const format = resolveFormatFromCommand(cmd, config);
    const execution = createPluginExecution(budget);
    let handlerStarted = false;
    const running = Promise.resolve().then(async () => {
      execution.check();
      if (auth === 'required') ensureAuthenticated();
      const mod = await loadHandlers();
      // A slow import can settle after the command deadline; never start its handler.
      execution.check();
      const handler =
        handlerKey && mod.handlers && Object.prototype.hasOwnProperty.call(mod.handlers, handlerKey)
          ? mod.handlers[handlerKey]
          : undefined;
      if (typeof handler !== 'function')
        throw new Error(`plugin handler "${handlerKey}" not found`);
      const ctx: PluginContext = {
        config: sanitizeConfigForPlugin(config),
        directory: process.cwd(),
        abort: execution.signal,
        callOpenApi: makeCallOpenApi(execution.signal),
        format,
        runtime: { cliVersion: VERSION, language: site.defaults.language, isRepl: isReplMode() },
        errors: pluginErrors,
        terminal: { withInput: execution.withInput },
      };
      handlerStarted = true;
      await handler(ctx, cmd.optsWithGlobals(), actionArgs.slice(0, -2));
    });
    try {
      await Promise.race([execution.aborted, running]);
    } catch (err) {
      if (
        execution.signal.aborted &&
        handlerStarted &&
        (trustedDefault || execution.signal.reason?.code === 'USER_INTERRUPT')
      ) {
        // Give cooperative handlers bounded time to release terminal and I/O resources.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            running.catch(() => {}),
            new Promise<void>((resolve) => {
              cleanupTimer = setTimeout(resolve, 2_000);
            }),
          ]);
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
      if (err instanceof HandledError) throw err;
      handleError(normalizePluginError(err), format);
    } finally {
      execution.dispose();
    }
  });
  return cmd;
}

export function loadInstalledPlugins(manifestPath: string, pluginsDir: string): LoadablePlugin[] {
  const loadable: LoadablePlugin[] = [];
  for (const entry of readInstalledManifest(manifestPath).plugins) {
    if (entry.enabled === false || getDefaultPlugin(entry.name)) continue;
    const recordedDir = entry.path ?? join(pluginsDir, 'node_modules', entry.name);
    // Copied installs stay within plugin storage; link/bundle roots may be external.
    let pkgDir = recordedDir;
    if (entry.source === 'npm' || entry.source === 'local' || entry.source === 'archive') {
      if (hasPendingPluginInstall(pluginsDir, entry.name)) {
        const reinstall =
          entry.source === 'npm'
            ? `Run: ${formatCmd(`plugin install ${entry.name}`)}`
            : `Reinstall from the original local plugin directory: ${formatCmd('plugin install <path>')}`;
        warn(`"${entry.name}" has an interrupted installation. ${reinstall}`);
        continue;
      }
      const confined = resolveWithinBase(pluginsDir, recordedDir);
      try {
        if (confined === null || !isRealPathWithinBase(pluginsDir, confined)) {
          warn(
            `"${entry.name}" skipped: recorded path escapes the plugins directory (${recordedDir})`,
          );
          continue;
        }
      } catch {
        warn(`"${entry.name}" skipped: cannot resolve plugin directory (${recordedDir})`);
        continue;
      }
      pkgDir = confined;
    }
    try {
      if (
        (entry.source === 'npm' || entry.source === 'local' || entry.source === 'archive') &&
        existsSync(pkgDir) &&
        !isRealPathWithinBase(pkgDir, join(pkgDir, 'package.json'))
      ) {
        warn(`"${entry.name}" skipped: package.json escapes the package directory`);
        continue;
      }
      const manifest = readPluginPackageManifest(pkgDir);
      if (!manifest) {
        warn(`"${entry.name}" skipped: package manifest not found in ${pkgDir}`);
        continue;
      }
      loadable.push({ name: entry.name, version: entry.version, pkgDir, manifest });
    } catch {
      warn(`"${entry.name}" skipped: cannot read plugin metadata`);
    }
  }
  return loadable;
}

export function registerPluginCommands(
  program: Command,
  installed: readonly (LoadablePlugin | PluginDescriptor)[],
  options: { trustedDefault?: boolean } = {},
): void {
  const builtins = builtInNames.get(program) ?? collectReservedNames(program);
  if (!builtInNames.has(program)) builtInNames.set(program, builtins);
  const reserved = new Set(builtins);
  if (!options.trustedDefault) {
    for (const command of program.commands) {
      if (trustedPluginCommands.has(command)) {
        for (const name of pluginNames(command.name(), command.aliases())) reserved.add(name);
      }
    }
    for (const definition of getDefaultPlugins()) {
      for (const name of pluginNames(definition.command, definition.commandAliases))
        reserved.add(name);
    }
  }
  const accepted = program.commands.flatMap((cmd) => pluginNames(cmd.name(), cmd.aliases()));
  const reject = (message: string): void => {
    if (options.trustedDefault) throw new Error(message);
    warn(`${message} — skipped`);
  };

  for (const plugin of installed) {
    if (!options.trustedDefault && getDefaultPlugin(plugin.name)) continue;
    const commandCount = program.commands.length;
    try {
      const invalid = validateManifest(plugin.manifest);
      if (invalid) {
        reject(`"${plugin.name}": ${invalid}`);
        continue;
      }

      if (
        options.trustedDefault &&
        (typeof plugin.version !== 'string' || !isValidPluginVersion(plugin.version))
      )
        reject(`"${plugin.name}" has an invalid default version`);

      const minVer = plugin.manifest.minCliVersion;
      if (minVer !== undefined && !isValidPluginVersion(minVer)) {
        reject(`"${plugin.name}" has invalid minCliVersion "${minVer}"`);
        continue;
      }
      if (!isCliVersionCompatible(VERSION, minVer)) {
        reject(`"${plugin.name}" requires CLI >= ${minVer} (current ${VERSION})`);
        continue;
      }

      const names = pluginNames(plugin.manifest.command, plugin.manifest.commandAliases);
      const topName = names[0] ?? '';
      const verdict = resolvePluginConflict(names, reserved, accepted);
      if (verdict === 'reserved') {
        reject(`"${plugin.name}" command/alias "${topName}" collides with a built-in`);
        continue;
      }
      if (verdict === 'duplicate') {
        reject(`"${plugin.name}" command/alias "${topName}" already provided by another plugin`);
        continue;
      }

      const stub = buildStub(
        program,
        plugin.manifest,
        'loadHandlers' in plugin ? plugin.loadHandlers : diskModuleLoader(plugin),
        options.trustedDefault ? DEFAULT_PLUGIN_TIMEOUT_MS : PLUGIN_TIMEOUT_MS,
        options.trustedDefault === true,
        undefined,
      );
      // Group plugin commands under their declared category (default "Plugins"),
      // ordered after built-ins (order 900) so they sort into their own section
      // instead of the "Other" fallback.
      setCommandHelpMetadata(
        stub,
        plugin.manifest.category ?? 'Plugins',
        plugin.manifest.helpOrder ?? 900,
      );
      // Register all of this plugin's names (command + aliases) so a later
      // plugin colliding with any of them is reported as a duplicate.
      pluginOwners.set(stub, plugin.name);
      if (options.trustedDefault) trustedPluginCommands.add(stub);
      accepted.push(...names);
    } catch (err) {
      // Registration can fail after adding part of a command tree.
      (program.commands as Command[]).splice(commandCount);
      if (options.trustedDefault) {
        throw new CliError({
          code: 'PLUGIN_DEFAULT_INVALID',
          message: `Default plugin "${plugin.name}" failed to register: ${(err as Error).message}`,
          exitCode: EXIT_CODES.CONFIG_ERROR,
        });
      }
      warn(`"${plugin.name}" failed to load: ${(err as Error).message} — skipped`);
      continue;
    }
  }
}

const builtInNames = new WeakMap<Command, Set<string>>();
const pluginOwners = new WeakMap<Command, string>();
const trustedPluginCommands = new WeakSet<Command>();

export function getRegisteredPluginNames(program: Command): ReadonlyMap<string, readonly string[]> {
  const registered = new Map<string, readonly string[]>();
  for (const command of program.commands) {
    const owner = pluginOwners.get(command);
    if (owner) registered.set(owner, pluginNames(command.name(), command.aliases()));
  }
  return registered;
}
export function createPluginInstallContext(
  program: Command,
): Parameters<typeof ensureDefaultPlugin>[1] & { reservedNames: Set<string> } {
  let root = program;
  while (root.parent) root = root.parent;
  return {
    pluginsDir: getPluginsDir(),
    manifestPath: getPluginsManifestPath(),
    cliVersion: VERSION,
    reservedNames: builtInNames.get(root) ?? collectReservedNames(root),
    definitions: getDefaultPlugins(),
    archiveRoot: process.env[`${site.envPrefix}_PLUGIN_ARCHIVE_ROOT`],
  };
}

async function prepareDefaultCommand(
  definition: DefaultPlugin,
  context: ReturnType<typeof createPluginInstallContext>,
): Promise<LoadablePlugin> {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      new CliError({
        code: 'USER_CANCELLED',
        message: 'Plugin preparation cancelled.',
        exitCode: EXIT_CODES.USER_INTERRUPT,
      }),
    );
  const timer = setTimeout(
    () =>
      controller.abort(
        new CliError({
          code: 'PLUGIN_TIMEOUT',
          message: 'Plugin preparation timed out.',
          exitCode: EXIT_CODES.NETWORK_ERROR,
        }),
      ),
    DEFAULT_PLUGIN_TIMEOUT_MS,
  );
  const unregister = registerCommandInterrupt(cancel);
  process.once('SIGINT', cancel);
  try {
    const record = await ensureDefaultPlugin(definition, { ...context, signal: controller.signal });
    controller.signal.throwIfAborted();
    const pkgDir = record.path ?? join(context.pluginsDir, 'node_modules', record.name);
    const manifest = readPluginPackageManifest(pkgDir);
    if (!manifest)
      throw new CliError({
        code: 'PLUGIN_LOAD_FAILED',
        message: `Plugin "${record.name}" has no installed manifest`,
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    return { name: record.name, version: record.version, pkgDir, manifest };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
    unregister();
  }
}

function currentDefaultLoader(
  plugin: LoadablePlugin,
  definition: DefaultPlugin,
  context: ReturnType<typeof createPluginInstallContext>,
): PluginDescriptor['loadHandlers'] {
  return async () => {
    const current = readUsableDefaultPlugin(definition, context);
    if (
      !current ||
      current.record.version !== plugin.version ||
      !isDeepStrictEqual(current.manifest, plugin.manifest)
    ) {
      throw new CliError({
        code: 'PLUGIN_COMMAND_CHANGED',
        message: `Plugin "${plugin.name}" changed while preparing this command. Please retry the command.`,
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    }
    return diskModuleLoader(plugin)();
  };
}

function isPluginHelpCommand(
  parent: Command,
  selected: Command,
  args: readonly string[],
  placeholder: boolean,
): boolean {
  let current = parent;
  let reached = false;
  const valueToken = (token: string) => !token.startsWith('-') || /^-\d/.test(token);
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') return false;
    if (token.startsWith('-')) {
      const options: Option[] = [];
      for (let node: Command | null = current; node; node = node.parent)
        options.push(...node.options);
      const flags = token.startsWith('--')
        ? [token.split('=')[0]]
        : [...token.slice(1)].map((ch) => `-${ch}`);
      for (let offset = 0; offset < flags.length; offset++) {
        const option = options.find(
          (item) => item.long === flags[offset] || item.short === flags[offset],
        );
        if (!option) return false;
        if (!option.required && !option.optional) continue;
        const inline = token.startsWith('--') ? token.includes('=') : offset < flags.length - 1;
        if (
          !inline &&
          (option.required || (args[index + 1] !== undefined && valueToken(args[index + 1])))
        )
          index++;
        if (option.variadic)
          while (args[index + 1] !== undefined && valueToken(args[index + 1])) index++;
        break;
      }
      continue;
    }
    if (!reached) {
      if (pluginNames(selected.name(), selected.aliases()).includes(token)) {
        current = selected;
        reached = true;
      }
      continue;
    }
    const child = current.commands.find((candidate) =>
      pluginNames(candidate.name(), candidate.aliases()).includes(token),
    );
    if (child) {
      current = child;
      continue;
    }
    return (
      token === 'help' && (current.commands.length > 0 || (placeholder && current === selected))
    );
  }
  return false;
}

export function registerDefaultPluginCommands(
  program: Command,
  options: { onCommandsChanged?: (command: Command) => void } = {},
): void {
  const reserved = collectReservedNames(program);
  builtInNames.set(program, reserved);
  setOpenApiPolicyReservedNames(reserved);
  const context = createPluginInstallContext(program);
  for (const definition of getDefaultPlugins()) {
    const names = pluginNames(definition.command, definition.commandAliases);
    const registeredNames = program.commands.flatMap((cmd) =>
      pluginNames(cmd.name(), cmd.aliases()),
    );
    if (resolvePluginConflict(names, reserved, registeredNames) !== 'ok') {
      throw new CliError({
        code: 'PLUGIN_DEFAULT_INVALID',
        message: `Default plugin "${definition.name}" has a conflicting command or alias.`,
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    }
    const installed = readUsableDefaultPlugin(definition, context);
    let registered: Command | undefined;
    if (installed) {
      const plugin = {
        name: definition.name,
        version: installed.record.version,
        pkgDir: installed.pkgDir,
        manifest: installed.manifest,
      };
      try {
        registerPluginCommands(
          program,
          [{ ...plugin, loadHandlers: currentDefaultLoader(plugin, definition, context) }],
          { trustedDefault: true },
        );
        registered = program.commands.find((item) => item.name() === definition.command);
      } catch (error) {
        warn(
          `"${definition.name}" unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let placeholder = !registered;
    const command =
      registered ??
      program
        .command(definition.command)
        .description(
          'Plugin not installed or unavailable; it will be installed or upgraded automatically on use.',
        )
        .aliases(definition.commandAliases ?? [])
        .helpCommand(true)
        .allowUnknownOption(true)
        .allowExcessArguments(true);
    pluginOwners.set(command, definition.name);
    trustedPluginCommands.add(command);
    if (placeholder) {
      command.action(() => {
        command.outputHelp();
      });
      setCommandHelpMetadata(command, 'Plugins', 900);
    }
    program.hook('preSubcommand', async (parent, selected) => {
      const rawArgs = (parent as Command & { rawArgs: string[] }).rawArgs;
      if (
        selected !== command ||
        isHelpInvocation(rawArgs) ||
        isPluginHelpCommand(parent, command, rawArgs, placeholder)
      )
        return;
      const plugin = await prepareDefaultCommand(definition, context);
      placeholder = false;
      buildStub(
        program,
        plugin.manifest,
        currentDefaultLoader(plugin, definition, context),
        DEFAULT_PLUGIN_TIMEOUT_MS,
        true,
        undefined,
        command,
      );
      setCommandHelpMetadata(
        command,
        plugin.manifest.category ?? 'Plugins',
        plugin.manifest.helpOrder ?? 900,
      );
      options.onCommandsChanged?.(command);
    });
  }
}
