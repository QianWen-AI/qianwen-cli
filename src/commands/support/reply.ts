import { resolveFormat } from '../../output/format.js';
import { printJSON } from '../../output/json.js';
import { getEffectiveConfig } from '../../config/manager.js';
import { handleError, HandledError, CliError } from '../../utils/errors.js';
import { EXIT_CODES } from '../../utils/exit-codes.js';
import { ensureAuthenticated } from '../../auth/credentials.js';
import { createServices } from '../../services/index.js';
import { withSpinner } from '../../ui/spinner.js';
import { multilineInput } from '../../utils/multiline-input.js';

const MESSAGE_MAX_LENGTH = 2000;

export interface SupportReplyOptions {
  format?: string;
  message?: string;
}

export async function supportReplyAction(
  ticketId: string,
  options: SupportReplyOptions,
): Promise<void> {
  const config = getEffectiveConfig();
  const format = resolveFormat(options.format, config['output.format']);

  try {
    if (!options.message && !process.stdin.isTTY) {
      throw new CliError({
        code: 'INVALID_ARGUMENT',
        message: 'Support reply requires interactive terminal',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    ensureAuthenticated();
    const { supportService } = createServices();

    await withSpinner(
      'Loading ticket',
      () => supportService.getTicket(ticketId),
      format,
    );

    let message: string;

    if (options.message) {
      message = options.message.trim();
    } else {
      message = (
        await multilineInput({
          title: 'Your reply',
          placeholder: 'Type your reply message...',
        })
      ).trim();
    }

    if (!message) {
      console.log('Cancelled.');
      return;
    }

    let hasRisk = false;
    try {
      const riskCheck = await supportService.identifyRiskWord(ticketId, message);
      hasRisk = riskCheck.hasRisk;
    } catch {
      // Non-critical; proceed on failure.
    }

    if (hasRisk && options.message) {
      throw new CliError({
        code: 'RISK_WORD_DETECTED',
        message: 'Your message contains restricted content. Please revise and retry.',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });
    }

    while (hasRisk) {
      process.stderr.write('Your message may need revising.\n');
      const revised = (
        await multilineInput({
          title: 'Revise your reply message',
          placeholder: 'Edit your reply. Leave empty to cancel.',
        })
      ).trim();
      if (!revised) {
        console.log('Cancelled.');
        return;
      }
      message = revised;
      try {
        const recheck = await supportService.identifyRiskWord(ticketId, message);
        hasRisk = recheck.hasRisk;
      } catch {
        hasRisk = false;
      }
    }

    if (message.length > MESSAGE_MAX_LENGTH) {
      process.stderr.write(
        `Warning: Input exceeds ${MESSAGE_MAX_LENGTH} characters and has been truncated.\n`,
      );
      message = message.slice(0, MESSAGE_MAX_LENGTH);
    }

    await withSpinner(
      'Sending reply',
      () => supportService.createMessage(ticketId, message),
      format,
    );

    if (format === 'json') {
      printJSON({ ticketId, status: 'replied' });
      return;
    }

    console.log('\u2714  Reply sent.');
  } catch (error) {
    if (error instanceof HandledError) throw error;
    handleError(error, format);
  }
}
