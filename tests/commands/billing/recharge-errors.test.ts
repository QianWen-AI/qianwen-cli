import { describe, expect, it } from 'vitest';
import { RequestTimeoutError, ResponseParseError } from '../../../src/api/base-client.js';
import { GatewayEnvelopeError } from '../../../src/api/request-adapter.js';
import { toRechargeCliError } from '../../../src/commands/billing/balance/recharge-errors.js';
import {
  isTransientRechargeGatewayFailure,
  RechargeCreateUnknownError,
  RechargeOrderNotFoundError,
} from '../../../src/services/billing-service.js';
import { classifyHttpError } from '../../../src/utils/api-errors.js';
import { CliError } from '../../../src/utils/errors.js';
import { EXIT_CODES } from '../../../src/utils/exit-codes.js';

describe('toRechargeCliError', () => {
  describe('missing recharge order', () => {
    it('maps the action-specific error to NOT_FOUND with exit 7 and actionable guidance', () => {
      const cause = new GatewayEnvelopeError(
        '500',
        'The request processing has failed due to some unknown error.',
      );

      const result = toRechargeCliError(new RechargeOrderNotFoundError(cause));

      expect(result).toBeInstanceOf(CliError);
      expect(result.code).toBe('NOT_FOUND');
      expect(result.exitCode).toBe(EXIT_CODES.NOT_FOUND);
      expect(result.message).toContain('Recharge order not found or unavailable for this account.');
      expect(result.message).toContain('qianwen billing balance recharge-history');
      expect(result.detail).toContain('[500]');
    });

    it('redacts an associated Nbid only at serialization time without mutating the source errors', () => {
      const nbid = 'nbid_sensitive_2684201000001';
      const nestedCause = new Error(`internal account ${nbid}`);
      const gatewayCause = Object.assign(
        new GatewayEnvelopeError(
          '500',
          'The request processing has failed due to some unknown error.',
        ),
        { Nbid: nbid, cause: nestedCause },
      );
      const source = new RechargeOrderNotFoundError(gatewayCause);

      const result = toRechargeCliError(source);
      const serialized = JSON.stringify(result.toJSON());

      expect(serialized).not.toContain(nbid);
      expect(serialized).toContain('[REDACTED]');
      expect(gatewayCause.Nbid).toBe(nbid);
      expect(nestedCause.message).toContain(nbid);
      expect(source.cause).toBe(gatewayCause);
    });
  });

  describe('uncertain recharge creation', () => {
    it('maps an HTTP-success JSON parse failure to CREATE_UNKNOWN with exit 1', () => {
      const parseError = new ResponseParseError(new SyntaxError('Unexpected token'));

      const result = toRechargeCliError(new RechargeCreateUnknownError(parseError));

      expect(result.code).toBe('CREATE_UNKNOWN');
      expect(result.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
      expect(result.message).toContain('result could not be confirmed');
    });

    it('recognizes a response parse marker through its cause chain', () => {
      const parseError = new ResponseParseError(new SyntaxError('Unexpected end of JSON input'));
      const wrapper = new Error('Network request failed while decoding', { cause: parseError });

      const result = toRechargeCliError(new RechargeCreateUnknownError(wrapper));

      expect(result.code).toBe('CREATE_UNKNOWN');
      expect(result.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
    });

    it.each([
      ['request timeout', new RequestTimeoutError(30_000, 'https://api.test.qianwenai.com')],
      ['network error', new Error('Network request failed: ECONNRESET')],
      ['HTTP 408', new Error('HTTP 408: Request Timeout')],
      ['HTTP 429', new Error('HTTP 429: Too Many Requests')],
      ['HTTP 503', new Error('HTTP 503: Service Unavailable')],
      ['gateway 408', new GatewayEnvelopeError('408', 'request timeout')],
      ['gateway 429', new GatewayEnvelopeError('429', 'rate limited')],
      ['temporary gateway error', new GatewayEnvelopeError('', 'temporarily unavailable')],
    ])('maps %s to CREATE_UNKNOWN with recharge-scoped exit 3', (_name, cause) => {
      const result = toRechargeCliError(new RechargeCreateUnknownError(cause));

      expect(result.code).toBe('CREATE_UNKNOWN');
      expect(result.exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
      expect(result.detail).toBeDefined();
      expect(result.detail).toContain(cause.message);
    });

    it('keeps a non-transient create failure at exit 1', () => {
      const result = toRechargeCliError(
        new RechargeCreateUnknownError(new Error('HTTP 400: Bad Request')),
      );

      expect(result.code).toBe('CREATE_UNKNOWN');
      expect(result.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
    });
  });

  describe('ordinary recharge failures', () => {
    it.each([
      ['HTTP 408', new Error('HTTP 408: Request Timeout'), 'API_ERROR', EXIT_CODES.GENERAL_ERROR],
      [
        'HTTP 429',
        new Error('HTTP 429: Too Many Requests'),
        'RATE_LIMITED',
        EXIT_CODES.RATE_LIMITED,
      ],
      [
        'HTTP 500',
        new Error('HTTP 500: Internal Server Error'),
        'SERVER_ERROR',
        EXIT_CODES.SERVER_ERROR,
      ],
      [
        'gateway 503',
        new GatewayEnvelopeError('503', 'service unavailable'),
        'API_ERROR',
        EXIT_CODES.GENERAL_ERROR,
      ],
      [
        'gateway keyword',
        new GatewayEnvelopeError('TEMPORARY', 'temporarily unavailable'),
        'API_ERROR',
        EXIT_CODES.GENERAL_ERROR,
      ],
    ])(
      'maps %s to exit 3 only at the recharge command boundary',
      (_name, error, expectedCode, globalExitCode) => {
        const globalResult = classifyHttpError(error);
        const result = toRechargeCliError(error);

        expect(globalResult.exitCode).toBe(globalExitCode);
        expect(result.code).toBe(expectedCode);
        expect(result.exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
      },
    );

    it('maps a response parse error to INVALID_RESPONSE without treating it as a network failure', () => {
      const result = toRechargeCliError(
        new ResponseParseError(new SyntaxError('Unexpected end of JSON input')),
      );

      expect(result.code).toBe('INVALID_RESPONSE');
      expect(result.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
      expect(result.message).toBe('Invalid recharge API response.');
    });

    it('preserves an existing non-transient CliError unchanged', () => {
      const source = new CliError({
        code: 'CONFIG_ERROR',
        message: 'Missing endpoint.',
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });

      const result = toRechargeCliError(source);

      expect(result).toBe(source);
      expect(result.exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    });

    it('keeps a non-transient gateway failure on the normal API error contract', () => {
      const result = toRechargeCliError(new GatewayEnvelopeError('400', 'invalid request'));

      expect(result.code).toBe('API_ERROR');
      expect(result.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
      expect(result.message).toBe('invalid request');
    });
  });
});

describe('isTransientRechargeGatewayFailure', () => {
  it.each([
    ['408', 'request rejected'],
    ['429', 'request rejected'],
    ['500', 'request rejected'],
    ['503', 'request rejected'],
    ['TEMPORARY', 'request rejected'],
    ['UNKNOWN', 'gateway unavailable'],
  ])('accepts transient gateway signal %s / %s', (code, message) => {
    expect(isTransientRechargeGatewayFailure(new GatewayEnvelopeError(code, message))).toBe(true);
  });

  it.each([
    ['400', 'invalid request'],
    ['401', 'unauthorized'],
    ['NOT_FOUND', 'missing resource'],
  ])('rejects non-transient gateway signal %s / %s', (code, message) => {
    expect(isTransientRechargeGatewayFailure(new GatewayEnvelopeError(code, message))).toBe(false);
  });

  it('rejects errors outside the gateway-envelope boundary', () => {
    expect(isTransientRechargeGatewayFailure(new Error('HTTP 503: Service Unavailable'))).toBe(
      false,
    );
  });
});
