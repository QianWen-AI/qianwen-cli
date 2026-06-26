import { resolveFormat } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError, HandledError } from '../../utils/errors.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { createServices } from '../../services/index.js';
import { withSpinner } from '../../ui/spinner.js';
import { buildSupportViewViewModel } from '../../view-models/support/index.js';
import { renderSupportViewInk } from '../../ui/SupportView.js';
import { renderTextSupportView } from '../../output/text/support.js';

export interface SupportViewOptions {
  format?: string;
}

export async function supportViewAction(
  ticketId: string,
  options: SupportViewOptions,
): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);

  try {
    ensureAuthenticated();
    const { supportService } = createServices();

    const { detail, messages } = await withSpinner(
      'Loading ticket',
      () => supportService.getTicketDetail(ticketId),
      format,
    );

    if (format === 'json') {
      printJSON({
        ticket: detail,
        messages: messages.messages,
        truncated: messages.truncated,
      });
      return;
    }

    const vm = buildSupportViewViewModel(detail, messages.messages, messages.truncated);

    if (format === 'text') {
      renderTextSupportView(vm);
      return;
    }

    await renderSupportViewInk(vm);
  } catch (error) {
    if (error instanceof HandledError) throw error;
    handleError(error, format);
  }
}
