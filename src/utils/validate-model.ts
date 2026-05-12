import type { ApiClient } from '../api/client.js';
import type { Model } from '../types/model.js';
import { CliError, invalidArgError, modelNotFoundError } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';
import { didYouMean } from './strings.js';

/**
 * Build a MODEL_NOT_FOUND CliError, appending a "Did you mean ..." clause when
 * a candidate ID is within edit-distance threshold.
 */
export function modelNotFoundWithSuggestion(id: string, candidates: string[]): CliError {
  const suggestion = didYouMean(id, candidates);
  if (!suggestion) return modelNotFoundError(id);
  return new CliError({
    code: 'MODEL_NOT_FOUND',
    message: `Model '${id}' not found. Did you mean '${suggestion}'?`,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

/**
 * Validate that `id` exists in the model registry and return the matched Model.
 * Throws CliError on failure:
 * - INVALID_ARGUMENT for empty id
 * - MODEL_NOT_FOUND (with optional did-you-mean) for unknown id
 *
 * Uses ApiClient.listModels which is internally cached, so repeated calls in
 * the same process are cheap. Returning the Model lets callers reuse its
 * metadata (modality, pricing, free_tier) without a second lookup.
 */
export async function validateModelId(
  client: Pick<ApiClient, 'listModels'>,
  id: string,
): Promise<Model> {
  if (!id || !id.trim()) {
    throw invalidArgError('Model ID is required.');
  }
  const { models } = await client.listModels();
  const matched = models.find((m) => m.id === id);
  if (matched) return matched;
  throw modelNotFoundWithSuggestion(
    id,
    models.map((m) => m.id),
  );
}
