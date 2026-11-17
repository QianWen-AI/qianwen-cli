import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export interface PluginCompatibilityMetadata {
  qianwen?: { minCliVersion?: string };
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ParsedVersion {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match) return null;
  return {
    major: match[1],
    minor: match[2] ?? '0',
    patch: match[3] ?? '0',
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

export function comparePluginVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    const compared = compareNumericIdentifiers(a[key], b[key]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    const aNumeric = /^\d+$/.test(av);
    const bNumeric = /^\d+$/.test(bv);
    if (aNumeric && !bNumeric) return -1;
    if (!aNumeric && bNumeric) return 1;
    const compared = aNumeric
      ? compareNumericIdentifiers(av, bv)
      : av === bv
        ? 0
        : av > bv
          ? 1
          : -1;
    if (compared !== 0) return compared;
  }
  return 0;
}

function minimumFromRange(range: string | undefined): string | undefined {
  if (range === undefined) return undefined;
  if (typeof range !== 'string') {
    throw new CliError({
      code: 'PLUGIN_METADATA_INVALID',
      message: 'Plugin minimum CLI version range must be a string.',
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
  if (!range) return undefined;
  const match =
    /(?:^|\s)(?:>=|\^|~)?\s*(v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(
      range.trim(),
    );
  return match?.[1];
}

export function resolveMinimumCliVersion(
  metadata: PluginCompatibilityMetadata,
): string | undefined {
  const minimum = metadata?.qianwen?.minCliVersion;
  if (minimum !== undefined) {
    if (typeof minimum !== 'string') {
      throw new CliError({
        code: 'PLUGIN_METADATA_INVALID',
        message: 'Plugin minCliVersion must be a string.',
        exitCode: EXIT_CODES.INVALID_ARGUMENT,
      });
    }
    return minimum;
  }
  for (const source of [metadata.engines, metadata.peerDependencies]) {
    const range = source?.['@qianwenai/qianwen-cli'] ?? source?.['@qianwenai/qianwen-cli'];
    const minimum = minimumFromRange(range);
    if (minimum) return minimum;
  }
  return undefined;
}

export function isCliVersionCompatible(current: string, minimum: string | undefined): boolean {
  if (minimum === undefined) return true;
  const compared = comparePluginVersions(current, minimum);
  return compared !== null && compared >= 0;
}

export function isValidPluginVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

export function isPrereleasePluginVersion(version: string): boolean {
  return (parseVersion(version)?.prerelease.length ?? 0) > 0;
}

export function resolveHighestCompatiblePluginVersion(
  versions: Record<string, PluginCompatibilityMetadata>,
  currentCliVersion: string,
  excludeVersion?: string,
  includePrerelease = false,
): string | undefined {
  return Object.entries(versions)
    .filter(([version, metadata]) => {
      if (version === excludeVersion) return false;
      if (!isValidPluginVersion(version)) return false;
      if (!includePrerelease && isPrereleasePluginVersion(version)) return false;
      try {
        const minimum = resolveMinimumCliVersion(metadata);
        if (minimum !== undefined && !isValidPluginVersion(minimum)) return false;
        return isCliVersionCompatible(currentCliVersion, minimum);
      } catch {
        return false;
      }
    })
    .map(([version]) => version)
    .sort((left, right) => comparePluginVersions(right, left) ?? 0)[0];
}
