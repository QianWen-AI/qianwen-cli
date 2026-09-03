import { isResponseParseError, RequestTimeoutError } from '../../../api/base-client.js';
import {
  findRechargeApiFailureStage,
  isTransientRechargeGatewayFailure,
  RechargeCreateUnknownError,
  RechargeOrderNotFoundError,
  type RechargeApiFailureStage,
} from '../../../services/billing-service.js';
import { classifyHttpError } from '../../../utils/api-errors.js';
import { CliError } from '../../../utils/errors.js';
import { EXIT_CODES } from '../../../utils/exit-codes.js';
import { redactPaymentError } from '../../../utils/strings.js';

const REAL_NAME_AUTHENTICATION_NOT_COMPLETED = 'RealNameAuthenticationNotCompleted';
const REAL_NAME_AUTHENTICATION_REQUIRED_MESSAGE =
  'Real-name authentication is required to recharge. You have not completed it yet. Please complete the verification before recharging.';

const RECHARGE_API_FAILURE_MESSAGES = {
  'load-human-info': 'Unable to load the billing account profile. Please try again later.',
  'billing-account-status':
    'Unable to verify whether this billing account can recharge. Please try again later.',
  'recharge-url': 'Unable to create the Alipay recharge order. Please try again later.',
  'result-query': 'Unable to query the recharge result. Please try again later.',
  'fund-flow': 'Unable to load recharge history. Please try again later.',
  'available-amount': 'Unable to load the available balance. Please try again later.',
} as const satisfies Readonly<Record<RechargeApiFailureStage, string>>;

/**
 * Normalize recharge failures without changing the global CLI error contract.
 *
 * Recharge commands expose transport, throttling, and temporary server failures
 * as exit 3. Other commands retain the existing global exit-code mapping.
 */
export function toRechargeCliError(error: unknown): CliError {
  if (error instanceof RechargeOrderNotFoundError) {
    const cause = error.cause;
    const classifiedCause = cause instanceof CliError ? cause : classifyHttpError(cause);
    const result = new CliError({
      code: error.code,
      message: error.message,
      exitCode: EXIT_CODES.NOT_FOUND,
      ...(classifiedCause.detail ? { detail: classifiedCause.detail } : {}),
    });
    redactPaymentError(result, error);
    return replaceRechargeApiFailureMessage(error, result, error.message);
  }

  if (error instanceof RechargeCreateUnknownError) {
    const cause = error.cause;
    const classifiedCause = cause instanceof CliError ? cause : classifyHttpError(cause);
    const exitCode = isResponseParseError(cause)
      ? EXIT_CODES.GENERAL_ERROR
      : isRechargeNetworkFailure(cause, classifiedCause)
        ? EXIT_CODES.NETWORK_ERROR
        : EXIT_CODES.GENERAL_ERROR;
    const result = new CliError({
      code: error.code,
      message: error.message,
      exitCode,
      ...(classifiedCause.detail ? { detail: classifiedCause.detail } : {}),
    });
    redactPaymentError(result, error);
    return replaceRechargeApiFailureMessage(error, result, error.message);
  }

  const classified = error instanceof CliError ? error : classifyHttpError(error);
  let result = classified;
  if (isRealNameAuthenticationNotCompleted(error)) {
    result = new CliError({
      code: classified.code,
      message: REAL_NAME_AUTHENTICATION_REQUIRED_MESSAGE,
      exitCode: classified.exitCode,
      ...(classified.detail ? { detail: classified.detail } : {}),
    });
  } else if (isResponseParseError(error)) {
    result = new CliError({
      code: 'INVALID_RESPONSE',
      message: 'Invalid recharge API response.',
      exitCode: EXIT_CODES.GENERAL_ERROR,
      ...(classified.detail ? { detail: classified.detail } : {}),
    });
  } else if (
    isRechargeNetworkFailure(error, classified) &&
    classified.exitCode !== EXIT_CODES.NETWORK_ERROR
  ) {
    result = new CliError({
      code: classified.code,
      message: classified.message,
      exitCode: EXIT_CODES.NETWORK_ERROR,
      ...(classified.detail ? { detail: classified.detail } : {}),
    });
  }

  // Classification creates a new Error. Keep the original request-bound
  // context reachable by the final diagnostic sink without mutating either.
  if (error instanceof Error && result !== error) redactPaymentError(result, error);
  return replaceRechargeApiFailureMessage(error, result);
}

/**
 * Map a recharge API failure to safe CLI copy while retaining its classification.
 *
 * The HTTP debug buffer already owns the original request and response record.
 * This function changes only the user-facing error object and deliberately
 * omits raw detail from terminal output, including verbose mode.
 *
 * @param error Original API or domain error.
 * @returns A safely worded error, or undefined when the error has no recharge API context.
 */
export function toRechargeApiCliError(error: unknown): CliError | undefined {
  const stage = findRechargeApiFailureStage(error);
  if (!stage) return undefined;
  const classified = error instanceof CliError ? error : classifyHttpError(error);
  return replaceRechargeApiFailureMessage(error, classified);
}

/** Replace only the public message for a known recharge API failure. */
function replaceRechargeApiFailureMessage(
  error: unknown,
  classified: CliError,
  preferredMessage?: string,
): CliError {
  const stage = findRechargeApiFailureStage(error);
  if (!stage) return classified;
  const message =
    preferredMessage ??
    (isRealNameAuthenticationNotCompleted(error)
      ? REAL_NAME_AUTHENTICATION_REQUIRED_MESSAGE
      : RECHARGE_API_FAILURE_MESSAGES[stage]);
  const result = new CliError({
    code: classified.code,
    message,
    exitCode: classified.exitCode,
  });
  if (error instanceof Error) redactPaymentError(result, error);
  return result;
}

/** Identify the exact gateway rejection returned when recharge KYC is incomplete. */
function isRealNameAuthenticationNotCompleted(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'GatewayEnvelopeError' &&
    Reflect.get(error, 'code') === REAL_NAME_AUTHENTICATION_NOT_COMPLETED
  );
}

/** Determine whether the recharge contract treats an error as transport failure. */
function isRechargeNetworkFailure(error: unknown, classified: CliError): boolean {
  if (
    error instanceof RequestTimeoutError ||
    classified.code === 'NETWORK_ERROR' ||
    classified.code === 'SERVER_ERROR' ||
    classified.code === 'RATE_LIMITED'
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  const httpStatus = error.message.match(/\bHTTP\s+(\d{3})\b/iu)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return status === 408 || status === 429 || status >= 500;
  }
  return isTransientRechargeGatewayFailure(error);
}
