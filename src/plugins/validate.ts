/**
 * Check local plugin metadata without importing code or changing install state.
 * A passing result does not prove that handlers are executable.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  parsePluginPackageManifest,
  validateManifest,
  type InstalledPlugin,
  type PluginManifest,
} from './manifest.js';
import { isSafePackageName } from './installer.js';
import { classifyInstallCollision, pluginNames } from './names.js';
import { isValidPluginVersion } from './compatibility.js';
import { resolveWithinBase } from '../utils/path-safety.js';
import type { DoctorCheck } from '../view-models/doctor.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function pass(name: string, detail: string): DoctorCheck {
  return { name, status: 'pass', detail };
}
function fail(name: string, detail: string, action?: string): DoctorCheck {
  return { name, status: 'fail', detail, ...(action ? { action } : {}) };
}
function warn(name: string, detail: string, action?: string): DoctorCheck {
  return { name, status: 'warn', detail, ...(action ? { action } : {}) };
}

/** Recursively collect every node's `auth` value (root + subcommands). */
function collectAuthValues(node: unknown, out: unknown[]): boolean {
  if (!isObject(node)) return false;
  out.push(node.auth);
  if (node.subcommands === undefined) return true;
  if (!Array.isArray(node.subcommands)) return false;
  let valid = true;
  for (const sub of node.subcommands) {
    if (!collectAuthValues(sub, out)) valid = false;
  }
  return valid;
}

/** Collect static validation results using the caller's command ownership metadata. */
export function runPluginValidateChecks(
  pkgDir: string,
  reserved: Set<string>,
  installed: InstalledPlugin[],
  registered: ReadonlyMap<string, readonly string[]> = new Map(),
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const pkgPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    checks.push(fail('package.json', `no package.json in ${pkgDir}`, 'Create a package.json.'));
    return checks;
  }
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!isObject(parsed)) {
      checks.push(fail('package.json', 'package.json must contain a JSON object'));
      return checks;
    }
    pkg = parsed;
  } catch {
    checks.push(fail('package.json', 'package.json is not valid JSON', 'Fix the JSON syntax.'));
    return checks;
  }
  checks.push(pass('package.json', 'present and valid JSON'));

  if (typeof pkg.name !== 'string' || pkg.name === '') {
    checks.push(fail('name', 'package.json missing "name"'));
  } else if (!isSafePackageName(pkg.name)) {
    checks.push(fail('name', `unsafe package name "${pkg.name}"`, 'Use a valid npm package name.'));
  } else {
    checks.push(pass('name', `"${pkg.name}" is a valid npm name`));
  }

  if (typeof pkg.version !== 'string' || !isValidPluginVersion(pkg.version)) {
    checks.push(
      fail(
        'version',
        'invalid package.version: expected a valid version string',
        'Set package.version to a valid version, such as 1.0.0 or 1.0.0-beta.1.',
      ),
    );
  } else {
    checks.push(pass('version', `package.version "${pkg.version}" is valid`));
  }

  let manifest: PluginManifest | null;
  let minimumError: string | undefined;
  try {
    manifest = parsePluginPackageManifest(pkg);
  } catch (error) {
    minimumError = error instanceof Error ? error.message : 'invalid minimum CLI metadata';
    // A broken version range must not suppress unrelated static checks.
    manifest = parsePluginPackageManifest({
      ...pkg,
      engines: undefined,
      peerDependencies: undefined,
    });
  }
  if (!manifest) {
    checks.push(
      fail(
        'qianwen-manifest',
        'no "qianwen" field in package.json — this package is not a plugin',
        'Add a "qianwen" command-tree field to package.json.',
      ),
    );
    return checks; // Nothing else is checkable without the manifest.
  }
  checks.push(pass('qianwen-manifest', 'qianwen field present'));

  const structural = validateManifest(manifest);
  if (structural) {
    checks.push(fail('manifest-structure', structural));
  } else {
    checks.push(pass('manifest-structure', 'command, entry, and leaf handlerKeys present'));
  }

  // The entry must remain inside the package, including through symlinks.
  if (typeof manifest.entry !== 'string' || manifest.entry.length === 0) {
    checks.push(fail('entry-file', 'entry must be a non-empty string'));
  } else {
    const resolved = resolveWithinBase(pkgDir, manifest.entry);
    if (resolved === null) {
      checks.push(fail('entry-file', `entry "${manifest.entry}" escapes the package directory`));
    } else if (!fs.existsSync(resolved)) {
      checks.push(
        fail('entry-file', `entry file not found: ${manifest.entry}`, 'Build the plugin first.'),
      );
    } else if (!fs.statSync(resolved).isFile()) {
      checks.push(fail('entry-file', `entry is not a regular file: ${manifest.entry}`));
    } else if (resolveWithinBase(fs.realpathSync(pkgDir), fs.realpathSync(resolved)) === null) {
      checks.push(fail('entry-file', `entry "${manifest.entry}" escapes the package directory`));
    } else {
      checks.push(pass('entry-file', `entry file ${manifest.entry} exists`));
    }
  }

  if (minimumError) checks.push(fail('minCliVersion', minimumError));
  else if (manifest.minCliVersion !== undefined) {
    if (!isValidPluginVersion(manifest.minCliVersion)) {
      checks.push(
        fail('minCliVersion', `"${describeValue(manifest.minCliVersion)}" is not a valid semver`),
      );
    } else {
      checks.push(pass('minCliVersion', `${manifest.minCliVersion} is valid`));
    }
  }

  const authValues: unknown[] = [];
  const traversable = collectAuthValues(manifest, authValues);
  if (!traversable) {
    checks.push(fail('auth', 'auth cannot be fully checked: malformed subcommands'));
  }
  const badAuth = authValues.filter((a) => a !== undefined && a !== 'required' && a !== 'optional');
  if (badAuth.length > 0) {
    checks.push(
      warn(
        'auth',
        `invalid auth value(s): ${badAuth.map(describeValue).join(', ')} (expected required|optional)`,
      ),
    );
  } else if (traversable) {
    checks.push(pass('auth', 'auth values valid'));
  }

  // Reinstallation exempts only names already owned by this plugin.
  if (
    typeof manifest.command !== 'string' ||
    (manifest.commandAliases !== undefined &&
      (!Array.isArray(manifest.commandAliases) ||
        !manifest.commandAliases.every((alias) => typeof alias === 'string')))
  ) {
    checks.push(
      fail('command-collision', 'collision check requires a string command and string aliases'),
    );
    return checks;
  }
  const names = pluginNames(manifest.command, manifest.commandAliases);
  const selfName = typeof pkg.name === 'string' ? pkg.name : '';
  const otherRegistered = [...registered].some(
    ([owner, commands]) => owner !== selfName && names.some((name) => commands.includes(name)),
  );
  const verdict = otherRegistered
    ? 'duplicate'
    : classifyInstallCollision(
        manifest.command,
        manifest.commandAliases,
        reserved,
        installed,
        selfName,
      );
  if (verdict === 'reserved') {
    checks.push(
      fail('command-collision', `command/alias collides with a built-in: ${names.join(', ')}`),
    );
  } else if (verdict === 'duplicate') {
    checks.push(
      fail(
        'command-collision',
        `command/alias already provided by another plugin: ${names.join(', ')}`,
      ),
    );
  } else {
    checks.push(pass('command-collision', 'command and aliases are free'));
  }

  return checks;
}
