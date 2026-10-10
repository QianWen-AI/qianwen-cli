import type { SubscriptionDiagnostic } from '../types/subscription.js';
import { classifyHttpError } from '../utils/api-errors.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

const AUTH_MESSAGE = 'Authentication failed. Run: qianwen auth login';
const NETWORK_MESSAGE = 'The service could not be reached. Check your network connection.';
const PROTOCOL_MESSAGE = 'The response could not be verified. Try again later.';
const UNAVAILABLE_MESSAGE = 'The service is temporarily unavailable. Try again later.';

function isProtocolFailure(error: unknown, classified: CliError): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      (error.name === 'GatewayShapeError' || error.name === 'ResponseParseError')) ||
    classified.code === 'PROTOCOL_ERROR' ||
    classified.code === 'PAYMENT_PROTOCOL_ERROR' ||
    classified.exitCode === EXIT_CODES.CONFIG_ERROR
  );
}

/** Convert a remote failure into the small, user-safe diagnostic vocabulary. */
export function safeSubscriptionDiagnostic(api: string, error: unknown): SubscriptionDiagnostic {
  const classified = classifyHttpError(error);
  if (classified.exitCode === EXIT_CODES.AUTH_FAILURE) {
    return { api, errorCode: 'AUTH_REQUIRED', errorMessage: AUTH_MESSAGE };
  }
  if (classified.exitCode === EXIT_CODES.NETWORK_ERROR) {
    return { api, errorCode: 'NETWORK_ERROR', errorMessage: NETWORK_MESSAGE };
  }
  if (isProtocolFailure(error, classified)) {
    return { api, errorCode: 'PROTOCOL_ERROR', errorMessage: PROTOCOL_MESSAGE };
  }
  return { api, errorCode: 'SERVICE_UNAVAILABLE', errorMessage: UNAVAILABLE_MESSAGE };
}

/**
 * Normalize a command-ending subscription failure without retaining backend
 * messages or verbose details. DEBUG_HTTP remains the sole raw diagnostic path.
 */
export function safeSubscriptionError(error: unknown, fallbackMessage: string): CliError {
  const classified = classifyHttpError(error);
  if (classified.exitCode === EXIT_CODES.AUTH_FAILURE) {
    return new CliError({
      code: 'AUTH_REQUIRED',
      message: AUTH_MESSAGE,
      exitCode: EXIT_CODES.AUTH_FAILURE,
    });
  }
  if (classified.exitCode === EXIT_CODES.NETWORK_ERROR) {
    return new CliError({
      code: 'NETWORK_ERROR',
      message: NETWORK_MESSAGE,
      exitCode: EXIT_CODES.NETWORK_ERROR,
    });
  }
  if (classified.exitCode === EXIT_CODES.RATE_LIMITED) {
    return new CliError({
      code: 'RATE_LIMITED',
      message: 'Too many requests. Wait and try again.',
      exitCode: EXIT_CODES.RATE_LIMITED,
    });
  }
  if (classified.exitCode === EXIT_CODES.SERVER_ERROR) {
    return new CliError({
      code: 'SERVICE_UNAVAILABLE',
      message: UNAVAILABLE_MESSAGE,
      exitCode: EXIT_CODES.SERVER_ERROR,
    });
  }
  if (isProtocolFailure(error, classified)) {
    return new CliError({
      code: 'PROTOCOL_ERROR',
      message: PROTOCOL_MESSAGE,
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  }
  return new CliError({
    code: 'SUBSCRIPTION_SERVICE_UNAVAILABLE',
    message: fallbackMessage,
    exitCode: EXIT_CODES.GENERAL_ERROR,
  });
}

/** Build a stable diagnostic for locally detected response-shape problems. */
export function subscriptionProtocolDiagnostic(
  api: string,
  errorCode: string,
  message = PROTOCOL_MESSAGE,
): SubscriptionDiagnostic {
  return { api, errorCode, errorMessage: message };
}
