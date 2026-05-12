import { createClient } from '../../api/client.js';
import type { ModelDetail } from '../../types/model.js';
import { resolveFormat } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { renderTextModelDetail } from '../../output/text/models.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError, modelNotFoundError } from '../../utils/errors.js';
import { modelNotFoundWithSuggestion } from '../../utils/validate-model.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { buildModelDetailViewModel } from '../../view-models/models.js';
import { renderModelInfoInk } from '../../ui/ModelInfo.js';
import { withSpinner } from '../../ui/spinner.js';

export interface ModelsInfoOptions {
  format?: string;
}

export async function modelsInfoAction(id: string, options: ModelsInfoOptions): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);

  try {
    await ensureAuthenticated();
    const client = await createClient();
    const model: ModelDetail = await withSpinner(
      `Fetching ${id}`,
      () => client.getModel(id),
      format,
    );

    if (format === 'json') {
      printJSON(model);
      return;
    }

    // Build ViewModel
    const vm = buildModelDetailViewModel(model);

    if (format === 'text') {
      renderTextModelDetail(vm);
      return;
    }

    // Table mode (Ink card)
    await renderModelInfoInk(vm);
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      // Try to enrich the error with a did-you-mean suggestion. listModels is
      // cached internally, so this is cheap on the cold-miss case too. Build
      // the enriched error first, then hand off to handleError once — wrapping
      // handleError in try/catch would call it twice (handleError throws via
      // process.exit and the catch would swallow it).
      let enriched = modelNotFoundError(id);
      try {
        const client = await createClient();
        const { models } = await client.listModels();
        enriched = modelNotFoundWithSuggestion(
          id,
          models.map((m) => m.id),
        );
      } catch {
        // Keep the basic not-found error if registry lookup fails.
      }
      handleError(enriched, format);
      return;
    }
    handleError(error, format);
  }
}
