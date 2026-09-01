/**
 * Unit tests for InvocationCredentialResolver — the four-tier credential chain
 * used by every model-invocation command.
 *
 * Per specification the chain is, highest priority first:
 *   1. explicit flag value
 *   2. environment variable
 *   3. OAuth token from the credential store
 *   4. persisted configuration value
 *
 * A resolved credential always reports which tier supplied it, so callers can
 * surface provenance in diagnostics. When every tier is empty the resolver is
 * expected to fail with an authentication-class exit code rather than return an
 * empty token.
 *
 * External dependencies (env, credential store, config) are injected, so these
 * tests drive the real resolver logic and never stub the resolution itself.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InvocationCredentialResolver,
  type CredentialResolverDeps,
  API_KEY_ENV_NAME,
  GENERIC_API_KEY_ENV_NAME,
} from '../../src/services/invocation-credential-resolver.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';

const ENV_NAME = 'QIANWEN_API_KEY';
const GENERIC_ALIAS = 'DASHSCOPE_API_KEY';

/**
 * Build dependency doubles for the three external sources. Every source is
 * empty by default so each test opts into exactly the tiers it exercises.
 */
function makeDeps(overrides: Partial<CredentialResolverDeps> = {}): CredentialResolverDeps {
  return {
    resolveOAuth: () => null,
    readEnv: () => undefined,
    readConfig: () => undefined,
    ...overrides,
  };
}

describe('InvocationCredentialResolver', () => {
  describe('tier precedence', () => {
    it('prefers the explicit flag over every other source', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({
          readEnv: () => 'sk-from-env',
          resolveOAuth: () => ({ access_token: 'token-from-oauth' }),
          readConfig: () => 'sk-from-config',
        }),
      );

      expect(resolver.resolve('sk-from-flag')).toEqual({
        token: 'sk-from-flag',
        source: 'flag',
      });
    });

    it('falls back to the environment variable when no flag is supplied', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({
          readEnv: (name) => (name === ENV_NAME ? 'sk-from-env' : undefined),
          resolveOAuth: () => ({ access_token: 'token-from-oauth' }),
          readConfig: () => 'sk-from-config',
        }),
      );

      expect(resolver.resolve()).toEqual({ token: 'sk-from-env', source: 'env' });
    });

    it('falls back to the OAuth token when flag and environment are empty', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({
          resolveOAuth: () => ({ access_token: 'token-from-oauth' }),
          readConfig: () => 'sk-from-config',
        }),
      );

      expect(resolver.resolve()).toEqual({ token: 'token-from-oauth', source: 'oauth' });
    });

    it('falls back to configuration as the lowest priority tier', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({ readConfig: () => 'sk-from-config' }),
      );

      expect(resolver.resolve()).toEqual({ token: 'sk-from-config', source: 'config' });
    });

    it('reads the credential from the documented environment variable name', () => {
      const readEnv = vi.fn(() => undefined);
      const resolver = new InvocationCredentialResolver(makeDeps({ readEnv }));

      expect(() => resolver.resolve()).toThrow(CliError);
      expect(readEnv).toHaveBeenCalledWith(ENV_NAME);
    });
  });

  describe('environment alias chain', () => {
    it('falls back to the generic DASHSCOPE alias when the primary env is empty', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({
          readEnv: (name) => (name === GENERIC_ALIAS ? 'sk-generic' : undefined),
        }),
      );

      expect(resolver.resolve()).toEqual({ token: 'sk-generic', source: 'env' });
    });

    it('prefers the primary env over the generic alias', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({
          readEnv: (name) => {
            if (name === ENV_NAME) return 'sk-primary';
            if (name === GENERIC_ALIAS) return 'sk-generic';
            return undefined;
          },
        }),
      );

      expect(resolver.resolve()).toEqual({ token: 'sk-primary', source: 'env' });
    });

    it('lets an explicit flag win over every environment alias', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({
          readEnv: () => 'sk-from-some-env',
        }),
      );

      expect(resolver.resolve('sk-flag')).toEqual({ token: 'sk-flag', source: 'flag' });
    });

    it('only reaches OAuth after all environment aliases are empty', () => {
      const readEnv = vi.fn(() => undefined);
      const resolver = new InvocationCredentialResolver(
        makeDeps({ readEnv, resolveOAuth: () => ({ access_token: 'token-oauth' }) }),
      );

      expect(resolver.resolve()).toEqual({ token: 'token-oauth', source: 'oauth' });
      expect(readEnv).toHaveBeenCalledWith(ENV_NAME);
      expect(readEnv).toHaveBeenCalledWith(GENERIC_ALIAS);
    });

    it('exposes the primary and generic env names as documented constants', () => {
      expect(API_KEY_ENV_NAME).toBe(ENV_NAME);
      expect(GENERIC_API_KEY_ENV_NAME).toBe(GENERIC_ALIAS);
    });
  });

  describe('empty and blank values are skipped', () => {
    it('ignores an empty-string flag and continues down the chain', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({ readEnv: () => 'sk-from-env' }),
      );

      expect(resolver.resolve('')).toEqual({ token: 'sk-from-env', source: 'env' });
    });

    it('ignores a whitespace-only environment value and continues down the chain', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({
          readEnv: () => '   ',
          resolveOAuth: () => ({ access_token: 'token-from-oauth' }),
        }),
      );

      expect(resolver.resolve()).toEqual({ token: 'token-from-oauth', source: 'oauth' });
    });

    it('ignores an OAuth entry carrying an empty access token', () => {
      const resolver = new InvocationCredentialResolver(
        makeDeps({
          resolveOAuth: () => ({ access_token: '' }),
          readConfig: () => 'sk-from-config',
        }),
      );

      expect(resolver.resolve()).toEqual({ token: 'sk-from-config', source: 'config' });
    });
  });

  describe('exhausted chain', () => {
    it('raises an authentication-class error when no tier yields a credential', () => {
      const resolver = new InvocationCredentialResolver(makeDeps());

      let captured: unknown;
      try {
        resolver.resolve();
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(CliError);
      expect((captured as CliError).exitCode).toBe(EXIT_CODES.AUTH_FAILURE);
    });

    it('emits a single-line factual missing-key message per specification', () => {
      const resolver = new InvocationCredentialResolver(makeDeps());

      let message = '';
      try {
        resolver.resolve();
      } catch (error) {
        message = (error as CliError).message;
      }

      expect(message).toContain('Missing API key');
      expect(message).toContain(ENV_NAME);
      expect(message).toContain(GENERIC_ALIAS);
      expect(message).toContain('--api-key');
      expect(message).toContain('https://platform.qianwenai.com/home/api-keys');
      expect(message).toContain('(shown once)');
      expect(message).not.toContain('login');
      expect(message.trim().split('\n')).toHaveLength(1);
    });

    it('does not consult the credential store once an earlier tier already matched', () => {
      const resolveOAuth = vi.fn(() => ({ access_token: 'token-from-oauth' }));
      const resolver = new InvocationCredentialResolver(
        makeDeps({ readEnv: () => 'sk-from-env', resolveOAuth }),
      );

      expect(resolver.resolve().source).toBe('env');
      expect(resolveOAuth).not.toHaveBeenCalled();
    });
  });
});
