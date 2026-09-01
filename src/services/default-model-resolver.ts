/** Resolves the model for a command when the user did not name one explicitly. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export const DEFAULT_MODEL_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface DefaultModelQuery {
  command: string;
  taskMode?: string;
}

export interface DefaultModelResolverDeps {
  fetchMapping: () => Promise<Record<string, string>>;
  readCache: () => Record<string, string> | null;
  writeCache: (mapping: Record<string, string>) => void;
}

function usable(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class DefaultModelResolver {
  constructor(private readonly deps: DefaultModelResolverDeps) {}

  async resolve(query: DefaultModelQuery, modelFlag?: string): Promise<string> {
    const explicit = usable(modelFlag);
    if (explicit) return explicit;

    const lookupKey = query.taskMode ? `${query.command}:${query.taskMode}` : query.command;

    const cached = usable(this.deps.readCache()?.[lookupKey]);
    if (cached) return cached;

    let mapping: Record<string, string> | null = null;
    try {
      mapping = await this.deps.fetchMapping();
    } catch {
      mapping = null;
    }

    if (mapping) {
      const resolved = usable(mapping[lookupKey]);
      if (resolved) {
        this.deps.writeCache(mapping);
        return resolved;
      }
    }

    throw new CliError({
      code: 'DEFAULT_MODEL_UNAVAILABLE',
      message: `Cannot determine a default model for "${query.command}". Pass --model explicitly.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
}
