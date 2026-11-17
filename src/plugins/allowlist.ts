/** Trusted public npm scope whose packages may be installed from the registry. */
export const ALLOWED_PLUGIN_SCOPES: ReadonlySet<string> = new Set(['@qianwenai']);

function scopeOf(pkg: string): string | null {
  if (!pkg.startsWith('@')) return null;
  const slash = pkg.indexOf('/');
  return slash > 1 ? pkg.slice(0, slash) : null;
}

/** Return true only when a package belongs to the trusted public scope. */
export function isOfficialPlugin(pkg: string): boolean {
  const scope = scopeOf(pkg);
  return scope !== null && ALLOWED_PLUGIN_SCOPES.has(scope);
}
