import { describe, it, expect } from 'vitest';
import { classifyHttpError } from '../../src/utils/api-errors.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('classifyHttpError', () => {
  it('passes through existing CliError unchanged', () => {
    const err = new CliError({
      code: 'CONFIG_ERROR',
      message: 'Bad config',
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
    const result = classifyHttpError(err);
    expect(result).toBe(err);
    expect(result.code).toBe('CONFIG_ERROR');
    expect(result.message).toBe('Bad config');
  });

  it('classifies AbortError (timeout) as NETWORK_ERROR', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const result = classifyHttpError(err, 'https://example.com/api');
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.message).toBe('Request timed out. Try again later.');
    expect(result.exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
    expect(result.detail).toContain('Request timed out');
  });

  it('classifies ECONNREFUSED as NETWORK_ERROR', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
    const result = classifyHttpError(err);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.message).toBe('API unreachable. Check your network connection.');
    expect(result.exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
  });

  it('classifies ENOTFOUND as NETWORK_ERROR', () => {
    const err = new Error('getaddrinfo ENOTFOUND api.example.com');
    const result = classifyHttpError(err);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.message).toBe('API unreachable. Check your network connection.');
  });

  it('classifies HTTP 401 as AUTH_REQUIRED', () => {
    const err = new Error('HTTP 401: Unauthorized');
    const result = classifyHttpError(err, 'https://example.com/api');
    expect(result.code).toBe('AUTH_REQUIRED');
    expect(result.message).toContain('Not authenticated');
    expect(result.exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
  });

  it('classifies HTTP 403 as TOKEN_EXPIRED', () => {
    const err = new Error('HTTP 403: Forbidden');
    const result = classifyHttpError(err);
    expect(result.code).toBe('TOKEN_EXPIRED');
    expect(result.message).toContain('Token expired');
    expect(result.exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
  });

  it('classifies HTTP 404 as NOT_FOUND', () => {
    const err = new Error('HTTP 404: Not Found');
    const result = classifyHttpError(err);
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toBe('Resource not found.');
    expect(result.exitCode).toBe(EXIT_CODES.NOT_FOUND);
  });

  it('classifies HTTP 429 as RATE_LIMITED', () => {
    const err = new Error('HTTP 429: Too Many Requests');
    const result = classifyHttpError(err);
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.message).toBe('Too many requests. Wait and retry.');
    expect(result.exitCode).toBe(EXIT_CODES.RATE_LIMITED);
  });

  it('classifies HTTP 500 as SERVER_ERROR', () => {
    const err = new Error('HTTP 500: Internal Server Error');
    const result = classifyHttpError(err);
    expect(result.code).toBe('SERVER_ERROR');
    expect(result.message).toBe('Server error. Try again later.');
    expect(result.exitCode).toBe(EXIT_CODES.SERVER_ERROR);
  });

  it('classifies HTTP 502 as SERVER_ERROR', () => {
    const err = new Error('HTTP 502: Bad Gateway');
    const result = classifyHttpError(err);
    expect(result.code).toBe('SERVER_ERROR');
    expect(result.exitCode).toBe(EXIT_CODES.SERVER_ERROR);
  });

  it('classifies HTTP 418 (other) as API_ERROR', () => {
    const err = new Error("HTTP 418: I'm a Teapot");
    const result = classifyHttpError(err);
    expect(result.code).toBe('API_ERROR');
    expect(result.message).toBe('API request failed.');
    expect(result.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
  });

  it('classifies "Network request failed" as NETWORK_ERROR', () => {
    const err = new Error('Network request failed: something broke');
    const result = classifyHttpError(err);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.message).toBe('Network error. Check your connection and try again.');
  });

  it('classifies "Not authenticated" as AUTH_REQUIRED', () => {
    const err = new Error('Not authenticated. Please login first:\n\n  qianwen login');
    const result = classifyHttpError(err);
    expect(result.code).toBe('AUTH_REQUIRED');
    expect(result.message).toContain('Not authenticated');
  });

  it('classifies "API error:" as API_ERROR', () => {
    const err = new Error('API error: Something went wrong');
    const result = classifyHttpError(err);
    expect(result.code).toBe('API_ERROR');
    expect(result.message).toBe('API request failed. Try again later.');
  });

  it('classifies unknown Error as UNKNOWN_ERROR', () => {
    const err = new Error('Something unexpected');
    const result = classifyHttpError(err);
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.message).toBe('An unexpected error occurred.');
    expect(result.exitCode).toBe(EXIT_CODES.GENERAL_ERROR);
  });

  it('classifies non-Error value as UNKNOWN_ERROR', () => {
    const result = classifyHttpError('string error');
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.message).toBe('An unexpected error occurred.');
  });

  it('includes URL in detail when provided', () => {
    const err = new Error('HTTP 500: Internal Server Error');
    const result = classifyHttpError(err, 'https://api.example.com/v2');
    expect(result.detail).toContain('https://api.example.com/v2');
  });

  it('includes cause chain in detail', () => {
    const cause = new Error('Root cause');
    const err = new Error('Failed to connect', { cause });
    const result = classifyHttpError(err, 'https://example.com');
    expect(result.detail).toContain('Caused by: Root cause');
  });
});
