/**
 * Unit tests for InvocationEnvelope.
 *
 * Per specification the success envelope carries meta plus data; the request id
 * key is omitted when the upstream did not provide one, and asynchronous
 * submissions surface the task id inside data. The failure envelope returns the
 * upstream message verbatim, never appending retry wording, and offers a hint
 * that points at the documentation lookup commands when a field is rejected.
 */
import { describe, it, expect } from 'vitest';
import {
  InvocationEnvelope,
  withFieldRejectionHint,
} from '../../src/services/invocation-envelope.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';
import type { NormalizedError, TokenUsage } from '../../src/types/model-invocation.js';

const USAGE: TokenUsage = { input: 10, output: 20, total: 30 };

describe('InvocationEnvelope', () => {
  describe('success', () => {
    it('wraps payload data under the data key', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.success({ text: 'hello' });

      expect(result.data).toEqual({ text: 'hello' });
    });

    it('includes the request id in meta when supplied', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.success({ text: 'hi' }, { requestId: 'req-123' });

      expect(result.meta.request_id).toBe('req-123');
    });

    it('omits the request id key entirely when it is absent', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.success({ text: 'hi' });

      expect('request_id' in result.meta).toBe(false);
    });

    it('includes usage in meta when supplied', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.success({ text: 'hi' }, { usage: USAGE });

      expect(result.meta.usage).toEqual(USAGE);
    });

    it('omits the usage key entirely when it is absent', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.success({ text: 'hi' }, { requestId: 'req-1' });

      expect('usage' in result.meta).toBe(false);
    });

    it('produces an empty meta object when neither request id nor usage is known', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.success({ text: 'hi' });

      expect(result.meta).toEqual({});
    });

    it('keeps the task id inside data for asynchronous submissions', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.success({ task_id: 'task-abc' }, { requestId: 'req-1' });

      expect(result.data.task_id).toBe('task-abc');
    });

    it('preserves nested data structure verbatim', () => {
      const envelope = new InvocationEnvelope();
      const data = { results: [{ url: 'https://mock-api.test.qianwenai.com/a.png' }] };

      const result = envelope.success(data);

      expect(result.data).toEqual(data);
    });

    it('exposes only the meta and data keys at the top level', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.success({ text: 'hi' }, { requestId: 'r', usage: USAGE });

      expect(Object.keys(result).sort()).toEqual(['data', 'meta']);
    });
  });

  describe('failure', () => {
    const upstream: NormalizedError = {
      code: 'InvalidParameter',
      message: 'The parameter `foo` is not supported by this model.',
    };

    it('returns the upstream message verbatim', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure(upstream);

      expect(result.error.message).toBe('The parameter `foo` is not supported by this model.');
    });

    it('carries the upstream code through unchanged', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure(upstream);

      expect(result.error.code).toBe('InvalidParameter');
    });

    it('never appends automatic retry wording to the message', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure(upstream);

      expect(result.error.message.toLowerCase()).not.toContain('retry');
      expect(result.error.message.toLowerCase()).not.toContain('retrying');
    });

    it('records the target model when supplied', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure(upstream, { model: 'qwen3.7-max' });

      expect(result.error.model).toBe('qwen3.7-max');
    });

    it('defaults the exit code to the general failure code', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure(upstream);

      expect(result.error.exit_code).toBe(1);
    });

    it('honours an explicit exit code override', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure(upstream, { exitCode: 4 });

      expect(result.error.exit_code).toBe(4);
    });

    it('exposes only the error key at the top level', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure(upstream, { model: 'm' });

      expect(Object.keys(result)).toEqual(['error']);
    });
  });

  describe('buildHint', () => {
    it('points at the documentation search command for unsupported field errors', () => {
      const envelope = new InvocationEnvelope();

      const hint = envelope.buildHint({
        code: 'InvalidParameter',
        message: 'Unknown field `enable_thinking` for this model.',
      });

      expect(hint).toBeDefined();
      expect(hint).toContain('docs search');
    });

    it('points at the model information command for unsupported field errors', () => {
      const envelope = new InvocationEnvelope();

      const hint = envelope.buildHint({
        code: 'InvalidParameter',
        message: 'Unknown field `enable_thinking` for this model.',
      });

      expect(hint).toContain('models info');
    });

    it('advises rebuilding the native passthrough body', () => {
      const envelope = new InvocationEnvelope();

      const hint = envelope.buildHint({
        code: 'InvalidParameter',
        message: 'Unknown field `enable_thinking` for this model.',
      });

      expect(hint).toContain('--request');
    });

    it('mentions the target model in the hint when known', () => {
      const envelope = new InvocationEnvelope();

      const hint = envelope.buildHint(
        { code: 'InvalidParameter', message: 'Unknown field `x`.' },
        { model: 'qwen3.7-max' },
      );

      expect(hint).toContain('qwen3.7-max');
    });

    it('returns no hint for an authentication failure', () => {
      const envelope = new InvocationEnvelope();

      const hint = envelope.buildHint({
        code: 'InvalidApiKey',
        message: 'Invalid API-key provided.',
      });

      expect(hint).toBeUndefined();
    });

    it('returns no hint for a transport level failure', () => {
      const envelope = new InvocationEnvelope();

      const hint = envelope.buildHint({
        code: 'NETWORK_ERROR',
        message: 'Request timed out after 60000ms',
      });

      expect(hint).toBeUndefined();
    });

    it('attaches the generated hint to the failure envelope', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure(
        { code: 'InvalidParameter', message: 'Unknown field `x` for this model.' },
        { model: 'qwen3.7-max' },
      );

      expect(result.error.hint).toContain('docs search');
    });

    it('omits the hint key on the envelope when no hint applies', () => {
      const envelope = new InvocationEnvelope();

      const result = envelope.failure({ code: 'InvalidApiKey', message: 'Invalid API-key.' });

      expect('hint' in result.error).toBe(false);
    });
  });

  describe('withFieldRejectionHint', () => {
    it('enriches a field-rejection CliError with model and hint', async () => {
      const rejected = new CliError({
        code: 'InvalidParameter',
        message: 'Unknown field `x`.',
        exitCode: EXIT_CODES.GENERAL_ERROR,
      });

      const error = await withFieldRejectionHint('wan2.7-t2v', () =>
        Promise.reject(rejected),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CliError);
      const cli = error as CliError;
      expect(cli.model).toBe('wan2.7-t2v');
      expect(cli.hint).toContain('docs search');
      expect(cli.code).toBe('InvalidParameter');
      expect(cli.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
    });

    it('passes non-field-rejection errors through untouched', async () => {
      const network = new CliError({
        code: 'NETWORK_ERROR',
        message: 'timed out',
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });

      const error = await withFieldRejectionHint('wan2.7-t2v', () => Promise.reject(network)).catch(
        (e: unknown) => e,
      );

      expect(error).toBe(network);
      expect((error as CliError).model).toBeUndefined();
      expect((error as CliError).hint).toBeUndefined();
    });

    it('returns the resolved value on success', async () => {
      const value = await withFieldRejectionHint('m', () => Promise.resolve({ ok: true }));
      expect(value).toEqual({ ok: true });
    });
  });
});
