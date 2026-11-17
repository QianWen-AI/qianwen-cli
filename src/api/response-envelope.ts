import { GatewayBusinessError } from './request-adapter.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

function invalidResponse(message: string): CliError {
  return new CliError({
    code: 'API_RESPONSE_INVALID',
    message,
    exitCode: EXIT_CODES.SERVER_ERROR,
  });
}

/** Applies only to operations explicitly configured with this response profile. */
export function unwrapSuccessCodeEnvelope(data: unknown, action: string): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidResponse(`${action} returned an invalid business envelope.`);
  }
  const envelope = data as Record<string, unknown>;
  const success = envelope.Success ?? envelope.success;
  const code = envelope.Code ?? envelope.code;
  if (
    (success != null && typeof success !== 'boolean') ||
    (code != null && typeof code !== 'string' && typeof code !== 'number') ||
    (success == null && code == null)
  ) {
    throw invalidResponse(`${action} returned an invalid business status.`);
  }
  if (success !== true && String(code) !== '200') {
    const message = envelope.Message ?? envelope.message;
    throw new GatewayBusinessError(
      String(code ?? 'UNKNOWN'),
      typeof message === 'string' ? message : `${action} request failed.`,
    );
  }
  const payload = envelope.Data !== undefined ? envelope.Data : envelope.data;
  if (payload === undefined) throw invalidResponse(`${action} response is missing data.`);
  return payload;
}
