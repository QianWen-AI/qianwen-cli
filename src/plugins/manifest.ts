import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveMinimumCliVersion } from './compatibility.js';
import { parsePluginApiPolicy, type OpenApiPolicyRule } from './api-policy.js';
import { validatePluginCommandTree } from './command-tree.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export type PluginSource = 'npm' | 'local' | 'archive' | 'link' | 'bundle';

export interface InstalledPlugin {
  name: string;
  version: string;
  enabled: boolean;
  source: PluginSource;
  path?: string;
  default?: boolean;
  /** Distinguishes committed installations, including reinstalls of the same version. */
  installationId?: string;
  /**
   * Top-level command this plugin contributes (normalized, no arg syntax).
   * Recorded at install time so ownership checks and listings avoid re-reading
   * the package manifest. Absent for entries written before this field existed.
   */
  command?: string;
  /**
   * Top-level command aliases this plugin contributes. Recorded alongside
   * `command` so collision checks cover aliases too (a plugin alias colliding
   * with a built-in/another plugin must be rejected, not silently shadowed).
   * Absent for entries written before this field existed → treated as none.
   */
  commandAliases?: string[];
}

export interface InstalledManifest {
  plugins: InstalledPlugin[];
  disabledDefaults?: string[];
}

export interface PluginOption {
  flag: string;
  description?: string;
  choices?: string[];
}

export interface PluginCommandNode {
  command: string;
  commandAliases?: string[];
  description?: string;
  category?: string;
  longDescription?: string;
  examples?: string[];
  helpOrder?: number;
  timeoutMs?: number;
  auth?: 'required' | 'optional';
  entry?: string;
  handlerKey?: string;
  options?: PluginOption[];
  subcommands?: PluginCommandNode[];
}

export type PluginManifest = PluginCommandNode & {
  minCliVersion?: string;
  apiPolicy?: OpenApiPolicyRule[];
};

export function readInstalledManifest(manifestPath: string): InstalledManifest {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { plugins: [] };
    throw installedManifestError();
  }
  try {
    const parsed = JSON.parse(raw) as InstalledManifest;
    if (
      !Array.isArray(parsed?.plugins) ||
      (parsed.disabledDefaults !== undefined && !Array.isArray(parsed.disabledDefaults))
    )
      throw installedManifestError();
    return {
      ...(Array.isArray(parsed.disabledDefaults)
        ? {
            disabledDefaults: [
              ...new Set(parsed.disabledDefaults.filter((name) => typeof name === 'string')),
            ],
          }
        : {}),
      plugins: parsed.plugins.filter((entry: unknown, index) => {
        if (isInstalledPlugin(entry)) return true;
        process.stderr.write(
          `qianwen: plugin entry ${index + 1} skipped: invalid installed metadata\n`,
        );
        return false;
      }),
    };
  } catch {
    throw installedManifestError();
  }
}

function installedManifestError(): CliError {
  return new CliError({
    code: 'CONFIG_ERROR',
    message:
      'Cannot read plugin installation manifest. Restore or repair plugins.json before retrying.',
    exitCode: EXIT_CODES.CONFIG_ERROR,
  });
}

function isInstalledPlugin(value: unknown): value is InstalledPlugin {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(entry.name) &&
    typeof entry.version === 'string' &&
    typeof entry.enabled === 'boolean' &&
    typeof entry.source === 'string' &&
    ['npm', 'local', 'archive', 'link', 'bundle'].includes(entry.source) &&
    (entry.path === undefined || (typeof entry.path === 'string' && entry.path.length > 0)) &&
    (entry.installationId === undefined || typeof entry.installationId === 'string') &&
    (entry.default === undefined || typeof entry.default === 'boolean') &&
    (entry.command === undefined || typeof entry.command === 'string') &&
    (entry.commandAliases === undefined || isStringArray(entry.commandAliases))
  );
}

export function writeInstalledManifest(manifestPath: string, manifest: InstalledManifest): void {
  const contents = JSON.stringify(manifest, null, 2) + '\n';
  const tmpPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, manifestPath);
    created = false;
    syncManifestDirectory(path.dirname(manifestPath));
  } finally {
    // Cleanup must preserve the original failure and never touch a file we did not create.
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write/close error.
      }
    }
    if (created) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Preserve the original write/rename error.
      }
    }
  }
}

function syncManifestDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Rename already committed: throwing here would roll back only the package directory.
    process.stderr.write(
      'qianwen: plugins.json committed, but directory sync failed; crash durability is not confirmed.\n',
    );
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The manifest is already committed; closing must not trigger package rollback either.
      }
    }
  }
}

function tryReadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface PackageJson {
  qianwen?: PluginManifest;
  main?: string;
  description?: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

// The command tree lives under package.json's `qianwen` field (npm-native, one
// source of truth). Standard package.json fields back-fill the top-level node
// only (subcommand description stays per-node); `??` keeps an explicit value.
export function parsePluginPackageManifest(value: unknown): PluginManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pkg = value as PackageJson;
  const base = pkg.qianwen;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return null;

  const derivedMinCliVersion = resolveMinimumCliVersion({
    engines: pkg.engines,
    peerDependencies: pkg.peerDependencies,
  });

  return {
    ...base,
    entry: base.entry ?? pkg.main,
    description: base.description ?? pkg.description,
    minCliVersion: base.minCliVersion !== undefined ? base.minCliVersion : derivedMinCliVersion,
  };
}

export function readPluginPackageManifest(pkgDir: string): PluginManifest | null {
  return parsePluginPackageManifest(tryReadJson<unknown>(path.join(pkgDir, 'package.json')));
}

/**
 * Validate the plugin command tree; return an error string or null when valid.
 */
export function validateManifest(manifest: PluginManifest): string | null {
  if (!manifest?.command) return 'manifest missing "command"';
  if (typeof manifest.command !== 'string') return 'manifest "command" must be a string';
  if (!manifest.entry) return 'manifest missing "entry"';
  if (typeof manifest.entry !== 'string') return 'manifest "entry" must be a string';
  if (manifest.apiPolicy !== undefined) {
    try {
      parsePluginApiPolicy(manifest.apiPolicy);
    } catch (error) {
      return `manifest ${error instanceof Error ? error.message : 'invalid apiPolicy'}`;
    }
  }
  if (manifest.commandAliases !== undefined && !isStringArray(manifest.commandAliases)) {
    return 'manifest "commandAliases" must be an array of strings';
  }
  if (manifest.minCliVersion !== undefined && typeof manifest.minCliVersion !== 'string') {
    return 'manifest "minCliVersion" must be a string';
  }
  const invalidNode = (node: PluginCommandNode, nodePath: string): string | null => {
    if (nodePath !== 'qianwen' && Object.prototype.hasOwnProperty.call(node, 'minCliVersion')) {
      return `${nodePath}.minCliVersion is only supported at the root; move it to qianwen.minCliVersion`;
    }
    if (node.longDescription !== undefined && typeof node.longDescription !== 'string')
      return 'manifest "longDescription" must be a string';
    if (node.examples !== undefined && !isStringArray(node.examples))
      return 'manifest "examples" must be an array of strings';
    if (
      node.helpOrder !== undefined &&
      (!Number.isFinite(node.helpOrder) || !Number.isInteger(node.helpOrder))
    )
      return 'manifest "helpOrder" must be an integer';
    if (
      node.timeoutMs !== undefined &&
      (!Number.isInteger(node.timeoutMs) || node.timeoutMs <= 0 || node.timeoutMs > 1_800_000)
    )
      return 'manifest "timeoutMs" must be an integer between 1 and 1800000';
    if (node.auth !== undefined && node.auth !== 'required' && node.auth !== 'optional') {
      return 'manifest "auth" must be required or optional';
    }
    if (node.commandAliases !== undefined && !isStringArray(node.commandAliases)) {
      return 'manifest "commandAliases" must be an array of strings';
    }
    if (node.options !== undefined) {
      if (!Array.isArray(node.options)) return 'manifest "options" must be an array';
      for (const option of node.options) {
        if (
          !option ||
          typeof option.flag !== 'string' ||
          !/^(?:-[a-zA-Z0-9](?:,? +|,))?--[a-zA-Z0-9][a-zA-Z0-9-]*(?: +(?:<[^<>[\]\s]+>|\[[^<>[\]\s]+\]))?$|^-[a-zA-Z0-9](?: +(?:<[^<>[\]\s]+>|\[[^<>[\]\s]+\]))?$/.test(
            option.flag,
          )
        ) {
          return 'manifest option has invalid flag syntax';
        }
        if (option.description !== undefined && typeof option.description !== 'string') {
          return 'manifest option description must be a string';
        }
        if (
          option.choices !== undefined &&
          (!isStringArray(option.choices) ||
            option.choices.length === 0 ||
            !/[<[]/.test(option.flag))
        ) {
          return 'manifest option choices require a value flag and a non-empty string array';
        }
      }
    }
    if (node.subcommands !== undefined && !Array.isArray(node.subcommands)) {
      return 'manifest "subcommands" must be an array';
    }
    if (node.subcommands?.length) {
      for (const [index, child] of node.subcommands.entries()) {
        if (!child?.command || typeof child.command !== 'string') {
          return 'subcommand missing a string "command"';
        }
        const childError = invalidNode(child, `${nodePath}.subcommands[${index}]`);
        if (childError) return childError;
      }
      return null;
    }
    if (!node.handlerKey) return 'leaf command missing "handlerKey"';
    return typeof node.handlerKey === 'string' && node.handlerKey.trim().length > 0
      ? null
      : 'leaf command "handlerKey" must be a non-empty string';
  };
  return invalidNode(manifest, 'qianwen') ?? validatePluginCommandTree(manifest);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
