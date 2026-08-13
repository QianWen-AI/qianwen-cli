/**
 * Minimal strict semver helpers for skill version comparison. Parsing is
 * deliberately conservative: only dotted numeric versions qualify (optional
 * leading "v", 1-3 segments with missing ones defaulting to 0, prerelease /
 * build suffixes ignored). Anything else is unparsable, and callers must
 * treat the comparison as unavailable instead of guessing — this keeps the
 * downgrade warning silent for opaque version strings.
 */

export interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/;

export function parseSemVer(version: string): ParsedSemVer | null {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/** True only when both versions parse and `a` is strictly greater than `b`. */
export function isSemVerGreater(a: string, b: string): boolean {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (!pa || !pb) return false;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key];
  }
  return false;
}
