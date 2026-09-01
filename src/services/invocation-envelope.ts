/** Builds the success and failure envelopes shared by all model-invocation commands. */

import { EXIT_CODES } from '../utils/exit-codes.js';
import { site } from '../site.js';
import { CliError } from '../utils/errors.js';
import type { NormalizedError } from '../types/model-invocation.js';
import type { ErrorEnvelope, SuccessEnvelope } from '../types/invocation-params.js';

/** Upstream codes that indicate the request body did not suit the target model. */
export const FIELD_REJECTION_CODES = new Set([
  'InvalidParameter',
  'InvalidParameters',
  'UnsupportedParameter',
  'UnsupportedOperation',
  'InvalidSchema',
  'MAPPING_NOT_FOUND',
  'UNSUPPORTED_FLAG',
]);

/**
 * Actionable next step for field-rejection errors, shared by the error envelope
 * and the transport boundary so both surface the same guidance. Returns
 * undefined for codes that are not field rejections.
 */
export function buildFieldRejectionHint(code: string, model?: string): string | undefined {
  if (!FIELD_REJECTION_CODES.has(code)) return undefined;
  const target = model ? ` for ${model}` : '';
  return `Check the supported fields${target} with \`${site.cliName} docs search\` or \`${site.cliName} models info\`, then rebuild --request accordingly.`;
}

/**
 * Run an upstream inference call, enriching a field-rejection `CliError` with
 * the target model and an actionable hint before it reaches `handleError`.
 *
 * The transport reports the upstream `{ code, message }` faithfully but has no
 * knowledge of which model was targeted (that lives in the service layer), so
 * the enrichment happens here at the service→transport boundary.
 */
export async function withFieldRejectionHint<T>(
  model: string | undefined,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CliError && error.hint === undefined) {
      // Only field-rejection errors get enriched; network/auth/etc. pass through
      // untouched so their shape stays stable.
      const hint = buildFieldRejectionHint(error.code, model);
      if (hint !== undefined) {
        throw new CliError({
          code: error.code,
          message: error.message,
          exitCode: error.exitCode,
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
          ...(model !== undefined ? { model } : {}),
          hint,
        });
      }
    }
    throw error;
  }
}

export class InvocationEnvelope {
  success(
    data: Record<string, unknown>,
    meta?: { requestId?: string; model?: string; usage?: Record<string, unknown> },
  ): SuccessEnvelope {
    const envelopeMeta: SuccessEnvelope['meta'] = {};
    if (meta?.requestId !== undefined) envelopeMeta.request_id = meta.requestId;
    if (meta?.model !== undefined) envelopeMeta.model = meta.model;
    if (meta?.usage !== undefined) envelopeMeta.usage = meta.usage;

    return { meta: envelopeMeta, data };
  }

  failure(error: NormalizedError, context?: { model?: string; exitCode?: number }): ErrorEnvelope {
    const payload: ErrorEnvelope['error'] = {
      code: error.code,
      message: error.message,
      exit_code: context?.exitCode ?? EXIT_CODES.GENERAL_ERROR,
    };

    if (context?.model !== undefined) payload.model = context.model;

    const hint = this.buildHint(error, context);
    if (hint !== undefined) payload.hint = hint;

    return { error: payload };
  }

  buildHint(error: NormalizedError, context?: { model?: string }): string | undefined {
    return buildFieldRejectionHint(error.code, context?.model);
  }
}
