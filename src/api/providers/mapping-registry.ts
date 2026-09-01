/** Field-template registry keyed by command, wire protocol, model family and task mode. */

import { CliError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import type { FilePolicy } from '../../types/invocation-params.js';

export type WireProtocol = 'openai-compatible' | 'dashscope-native';

export interface MappingKey {
  command: string;
  protocol: WireProtocol;
  modelFamily: string;
  taskMode: string;
}

export interface MappingEntry {
  key: MappingKey;
  fieldTemplates: Record<string, string>;
  capabilities: { streaming: boolean; asynchronous: boolean };
  filePolicy: FilePolicy;
}

function encode(key: MappingKey): string {
  return [key.command, key.protocol, key.modelFamily, key.taskMode].join('\u0000');
}

function describe(key: MappingKey): string {
  return `command "${key.command}", protocol "${key.protocol}", model family "${key.modelFamily}", task mode "${key.taskMode}"`;
}

export class MappingRegistry {
  private readonly entries = new Map<string, MappingEntry>();

  register(entry: MappingEntry): void {
    this.entries.set(encode(entry.key), entry);
  }

  lookup(key: MappingKey): MappingEntry | null {
    return this.entries.get(encode(key)) ?? null;
  }

  require(key: MappingKey): MappingEntry {
    const entry = this.lookup(key);
    if (entry) return entry;

    throw new CliError({
      code: 'MAPPING_NOT_FOUND',
      message: `No parameter mapping for ${describe(key)}. Use --request to send the native request body.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }

  requireFieldPath(key: MappingKey, flag: string): string {
    const entry = this.require(key);
    const path = entry.fieldTemplates[flag];
    if (path !== undefined) return path;

    throw new CliError({
      code: 'UNSUPPORTED_FLAG',
      message: `${flag} is not supported for ${describe(key)}. Use --request to set the native field instead.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
}
