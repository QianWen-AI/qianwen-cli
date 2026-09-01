/** Guards against a convenience flag and the native body setting the same semantic. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import type { ConflictReport, Layer2Assignment } from '../types/invocation-params.js';

function hasPath(body: Record<string, unknown>, path: string): boolean {
  const segments = path.split('.');
  let cursor: unknown = body;

  for (let i = 0; i < segments.length; i += 1) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
    const record = cursor as Record<string, unknown>;
    const segment = segments[i] as string;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return false;
    cursor = record[segment];
  }

  return true;
}

export class LayerConflictDetector {
  detect(assignments: Layer2Assignment[], requestBody: Record<string, unknown>): ConflictReport {
    const conflicts: ConflictReport['conflicts'] = [];

    for (const assignment of assignments) {
      for (const path of assignment.paths) {
        if (hasPath(requestBody, path)) {
          conflicts.push({ flag: assignment.flag, path });
        }
      }
    }

    return { conflicts };
  }

  assertNoConflict(assignments: Layer2Assignment[], requestBody: Record<string, unknown>): void {
    const { conflicts } = this.detect(assignments, requestBody);
    if (conflicts.length === 0) return;

    const details = conflicts.map((c) => `${c.flag} vs --request field "${c.path}"`).join('; ');
    throw new CliError({
      code: 'PARAM_LAYER_CONFLICT',
      message: `Conflicting settings: ${details}. Set the value either through the flag or through --request, not both.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }

  applyModelOverride(
    requestBody: Record<string, unknown>,
    modelFlag?: string,
  ): Record<string, unknown> {
    const next = { ...requestBody };
    if (typeof modelFlag === 'string' && modelFlag.trim().length > 0) {
      next.model = modelFlag;
    }
    return next;
  }
}
