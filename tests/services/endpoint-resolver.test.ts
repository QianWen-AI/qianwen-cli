/**
 * Unit tests for EndpointResolver — the four-tier endpoint chain shared by the
 * model-invocation commands.
 *
 * Per specification the chain is, highest priority first:
 *   1. explicit flag value
 *   2. environment variable
 *   3. persisted configuration value
 *   4. built-in default endpoint
 *
 * The flag accepts either a preset name or a full URL. A value that is neither
 * a known preset nor a parseable URL is an argument error. Resolution never
 * silently falls through to a different site.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  EndpointResolver,
  type EndpointResolverDeps,
} from '../../src/services/endpoint-resolver.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';
import { site } from '../../src/site.js';

const ENV_NAME = 'QIANWEN_ENDPOINT';
const PRESET_NAME = site.dashscopeEndpointName;

function makeDeps(overrides: Partial<EndpointResolverDeps> = {}): EndpointResolverDeps {
  return {
    readEnv: () => undefined,
    readConfig: () => undefined,
    ...overrides,
  };
}

describe('EndpointResolver', () => {
  describe('tier precedence', () => {
    it('prefers the explicit flag over every other source', () => {
      const resolver = new EndpointResolver(
        makeDeps({
          readEnv: () => 'https://env.test.qianwenai.com/v1',
          readConfig: () => 'https://config.test.qianwenai.com/v1',
        }),
      );

      expect(resolver.resolve('https://flag.test.qianwenai.com/v1')).toBe(
        'https://flag.test.qianwenai.com/v1',
      );
    });

    it('falls back to the environment variable when no flag is supplied', () => {
      const resolver = new EndpointResolver(
        makeDeps({
          readEnv: (name) => (name === ENV_NAME ? 'https://env.test.qianwenai.com/v1' : undefined),
          readConfig: () => 'https://config.test.qianwenai.com/v1',
        }),
      );

      expect(resolver.resolve()).toBe('https://env.test.qianwenai.com/v1');
    });

    it('falls back to configuration when flag and environment are empty', () => {
      const resolver = new EndpointResolver(
        makeDeps({ readConfig: () => 'https://config.test.qianwenai.com/v1' }),
      );

      expect(resolver.resolve()).toBe('https://config.test.qianwenai.com/v1');
    });

    it('falls back to the built-in default when every source is empty', () => {
      const resolver = new EndpointResolver(makeDeps());

      expect(resolver.resolve()).toBe(site.dashscopeEndpoint);
    });

    it('reads the endpoint from the documented environment variable name', () => {
      const readEnv = vi.fn(() => undefined);
      const resolver = new EndpointResolver(makeDeps({ readEnv }));

      resolver.resolve();

      expect(readEnv).toHaveBeenCalledWith(ENV_NAME);
    });
  });

  describe('preset name resolution', () => {
    it('resolves the built-in preset name to its URL', () => {
      const resolver = new EndpointResolver(makeDeps());

      expect(resolver.resolve(PRESET_NAME)).toBe(site.dashscopeEndpoint);
    });

    it('resolves a preset name supplied through the environment', () => {
      const resolver = new EndpointResolver(makeDeps({ readEnv: () => PRESET_NAME }));

      expect(resolver.resolve()).toBe(site.dashscopeEndpoint);
    });

    it('resolves a preset name supplied through configuration', () => {
      const resolver = new EndpointResolver(makeDeps({ readConfig: () => PRESET_NAME }));

      expect(resolver.resolve()).toBe(site.dashscopeEndpoint);
    });
  });

  describe('invalid values', () => {
    it('rejects a value that is neither a preset name nor a URL', () => {
      const resolver = new EndpointResolver(makeDeps());

      let captured: unknown;
      try {
        resolver.resolve('not-a-preset-nor-url');
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(CliError);
      expect((captured as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
    });

    it('names the offending value so the user can correct it', () => {
      const resolver = new EndpointResolver(makeDeps());

      let message = '';
      try {
        resolver.resolve('bogus-endpoint');
      } catch (error) {
        message = (error as CliError).message;
      }

      expect(message).toContain('bogus-endpoint');
    });

    it('ignores an empty flag and continues down the chain', () => {
      const resolver = new EndpointResolver(
        makeDeps({ readEnv: () => 'https://env.test.qianwenai.com/v1' }),
      );

      expect(resolver.resolve('')).toBe('https://env.test.qianwenai.com/v1');
    });

    it('ignores a whitespace-only environment value and continues down the chain', () => {
      const resolver = new EndpointResolver(makeDeps({ readEnv: () => '   ' }));

      expect(resolver.resolve()).toBe(site.dashscopeEndpoint);
    });
  });

  describe('token-plan routing', () => {
    it('routes an sk-sp token to the token-plan gateway when no override exists', () => {
      const resolver = new EndpointResolver(makeDeps());

      expect(resolver.resolve(undefined, 'sk-sp-abc')).toBe(site.tokenPlanEndpoint);
    });

    it('keeps an sk-ws token on the default gateway', () => {
      const resolver = new EndpointResolver(makeDeps());

      expect(resolver.resolve(undefined, 'sk-ws-abc')).toBe(site.dashscopeEndpoint);
    });

    it('keeps an unrecognised token on the default gateway', () => {
      const resolver = new EndpointResolver(makeDeps());

      expect(resolver.resolve(undefined, 'sk-other')).toBe(site.dashscopeEndpoint);
    });

    it('lets an explicit flag override token-plan routing', () => {
      const resolver = new EndpointResolver(makeDeps());

      expect(resolver.resolve('https://flag.test.qianwenai.com/v1', 'sk-sp-abc')).toBe(
        'https://flag.test.qianwenai.com/v1',
      );
    });

    it('lets an environment value override token-plan routing', () => {
      const resolver = new EndpointResolver(
        makeDeps({ readEnv: () => 'https://env.test.qianwenai.com/v1' }),
      );

      expect(resolver.resolve(undefined, 'sk-sp-abc')).toBe('https://env.test.qianwenai.com/v1');
    });
  });
});
