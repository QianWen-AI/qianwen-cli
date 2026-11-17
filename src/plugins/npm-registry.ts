/**
 * npm registry resolution for direct-download plugin installs.
 *
 * The installer fetches packuments and tarballs over HTTPS itself (no npm
 * subprocess). Only user-level `~/.npmrc` is trusted: a project's config must
 * not redirect an official scope to another code source. A scope-specific
 * `@scope:registry=` wins over `registry=`, and `//host/path/:_authToken=` supplies a
 * bearer token for private (scoped) registries. Unset falls back to the public
 * npmjs registry. Only the small subset npm-config keys the download path needs
 * is parsed; everything else in the file is ignored.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

interface NpmrcConfig {
  /** Global `registry=` value, normalized to a trailing slash. */
  registry?: string;
  /** `@scope` (with leading `@`) → registry URL. */
  scopeRegistries: Map<string, string>;
  /** Registry origin+path key (`//host/path/`) → auth token. */
  authTokens: Map<string, string>;
}

export interface RegistryTarget {
  /** Registry base URL, always trailing-slash terminated. */
  registry: string;
  /** Bearer token for this registry, when a matching `_authToken` was found. */
  authToken?: string;
}

/**
 * Resolve which registry (and optional auth token) to use for `pkg`. Scoped
 * packages (`@scope/name`) prefer a `@scope:registry=` entry; everything else
 * uses the global `registry=`; both fall back to the public npm registry.
 */
export function resolveRegistryForPackage(
  pkg: string,
  homeDir: string = os.homedir(),
  registryOverride?: string,
): RegistryTarget {
  const config = loadNpmrc(homeDir);

  let registry = config.registry ?? DEFAULT_REGISTRY;
  const scope = packageScope(pkg);
  if (scope) {
    const scoped = config.scopeRegistries.get(scope);
    if (scoped) registry = scoped;
  }
  registry =
    registryOverride === undefined
      ? withTrailingSlash(registry)
      : normalizeRegistryUrl(registryOverride);

  const authToken = matchAuthToken(registry, config.authTokens);
  return authToken ? { registry, authToken } : { registry };
}

/** Release configuration can pin a registry without carrying credentials. */
export function normalizeRegistryUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid npm registry');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || /[?#]/.test(value))
    throw new Error('Invalid npm registry');
  return withTrailingSlash(url.href);
}

/** Extract the `@scope` prefix (with leading `@`) from a package name, if any. */
function packageScope(pkg: string): string | null {
  if (!pkg.startsWith('@')) return null;
  const slash = pkg.indexOf('/');
  return slash > 0 ? pkg.slice(0, slash) : null;
}

/**
 * Match a registry URL against the collected `_authToken` keys. npm stores
 * these keyed by the registry's `//host/path/` (protocol-relative); the
 * longest matching prefix wins so a path-scoped token beats a host-wide one.
 */
function matchAuthToken(registry: string, tokens: Map<string, string>): string | undefined {
  const relative = registry.replace(/^https?:/, '');
  let best: { key: string; token: string } | undefined;
  for (const [key, token] of tokens) {
    if (relative.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, token };
    }
  }
  return best?.token;
}

/** Project registry and token settings are deliberately excluded. */
function loadNpmrc(homeDir: string): NpmrcConfig {
  const config: NpmrcConfig = { scopeRegistries: new Map(), authTokens: new Map() };
  parseNpmrcInto(path.join(homeDir, '.npmrc'), config);
  return config;
}

const SCOPE_REGISTRY_KEY = /^(@[^:]+):registry$/;
const AUTH_TOKEN_KEY = /^(\/\/.+?):_authToken$/;

function parseNpmrcInto(file: string, config: NpmrcConfig): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = expandEnv(stripQuotes(line.slice(eq + 1).trim()));
    if (value === '') continue;

    if (key === 'registry') {
      config.registry = value;
      continue;
    }
    const scopeMatch = SCOPE_REGISTRY_KEY.exec(key);
    if (scopeMatch) {
      config.scopeRegistries.set(scopeMatch[1], value);
      continue;
    }
    const authMatch = AUTH_TOKEN_KEY.exec(key);
    if (authMatch) {
      config.authTokens.set(withTrailingSlash(authMatch[1]), value);
    }
  }
}

/** Expand `${VAR}` references from the environment, as npm does. */
function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0];
    if (value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}
