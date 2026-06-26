import { resolveFormat } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError, HandledError, CliError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { createServices } from '../../services/index.js';
import { withSpinner } from '../../ui/spinner.js';
import { confirmPrompt } from '../../utils/confirm.js';

export interface SupportCloseOptions {
  yes?: boolean;
  format?: string;
}

export async function supportCloseAction(
  ticketId: string,
  options: SupportCloseOptions,
): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);

  try {
    if (!options.yes && !process.stdin.isTTY) {
      throw new CliError({
        code: 'INVALID_ARGUMENT',
        message: 'Support close requires interactive terminal (use --yes to skip confirmation)',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    ensureAuthenticated();
    const { supportService } = createServices();

    await withSpinner('Verifying ticket', () => supportService.getTicket(ticketId), format);

    if (!options.yes) {
      const confirmed = await confirmPrompt(`Close ticket ${ticketId}? This cannot be undone. [y/N]`);
      if (!confirmed) {
        if (format === 'json') {
          printJSON({ ticketId, cancelled: true });
        } else {
          console.log('Cancelled.');
        }
        return;
      }
    }

    await withSpinner('Closing ticket', () => supportService.cancelTicket(ticketId), format);

    if (format === 'json') {
      printJSON({ ticketId, status: 'closed' });
      return;
    }

    console.log(`\u2714  Ticket ${ticketId} closed.`);
  } catch (error) {
    if (error instanceof HandledError) throw error;
    handleError(error, format);
  }
}
