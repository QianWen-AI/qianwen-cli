/**
 * Unit tests for DefaultModelResolver.
 *
 * Per specification an explicit model wins outright and never silently falls
 * back. Otherwise the resolver consults its cache first and only then the
 * information centre, persisting what it learns. When there is no cache and the
 * information centre is unavailable the user is asked to pass the model
 * explicitly. The cache lifetime is three days.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DefaultModelResolver,
  DEFAULT_MODEL_CACHE_TTL_MS,
  type DefaultModelResolverDeps,
} from '../../src/services/default-model-resolver.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';

function makeDeps(overrides: Partial<DefaultModelResolverDeps> = {}): DefaultModelResolverDeps {
  return {
    fetchMapping: vi.fn().mockResolvedValue({}),
    readCache: () => null,
    writeCache: () => undefined,
    ...overrides,
  };
}

describe('DefaultModelResolver', () => {
  describe('cache lifetime', () => {
    it('declares a three day cache lifetime', () => {
      expect(DEFAULT_MODEL_CACHE_TTL_MS).toBe(3 * 24 * 60 * 60 * 1000);
    });
  });

  describe('explicit model precedence', () => {
    it('returns the explicit model without consulting any other source', async () => {
      const fetchMapping = vi.fn().mockResolvedValue({ 'chat create': 'cached-model' });
      const readCache = vi.fn().mockReturnValue({ 'chat create': 'cached-model' });
      const resolver = new DefaultModelResolver(makeDeps({ fetchMapping, readCache }));

      const model = await resolver.resolve({ command: 'chat create' }, 'explicit-model');

      expect(model).toBe('explicit-model');
      expect(fetchMapping).not.toHaveBeenCalled();
      expect(readCache).not.toHaveBeenCalled();
    });

    it('honours an explicit model even when the information centre would fail', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({
          fetchMapping: vi.fn().mockRejectedValue(new Error('upstream down')),
        }),
      );

      const model = await resolver.resolve({ command: 'video generate' }, 'wan2.7-t2v');

      expect(model).toBe('wan2.7-t2v');
    });
  });

  describe('cache hit path', () => {
    it('resolves from cache without calling the information centre', async () => {
      const fetchMapping = vi.fn().mockResolvedValue({});
      const resolver = new DefaultModelResolver(
        makeDeps({ fetchMapping, readCache: () => ({ 'chat create': 'qwen3.7-max' }) }),
      );

      const model = await resolver.resolve({ command: 'chat create' });

      expect(model).toBe('qwen3.7-max');
      expect(fetchMapping).not.toHaveBeenCalled();
    });

    it('distinguishes entries by task mode', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({
          readCache: () => ({ 'video generate:t2v': 'wan2.7-t2v', 'video generate:i2v': 'wan2.7-i2v' }),
        }),
      );

      const model = await resolver.resolve({ command: 'video generate', taskMode: 'i2v' });

      expect(model).toBe('wan2.7-i2v');
    });

    it('falls through to the information centre when the cache lacks the requested key', async () => {
      const fetchMapping = vi.fn().mockResolvedValue({ 'image generate': 'qwen-image-2.0' });
      const resolver = new DefaultModelResolver(
        makeDeps({ fetchMapping, readCache: () => ({ 'chat create': 'qwen3.7-max' }) }),
      );

      const model = await resolver.resolve({ command: 'image generate' });

      expect(model).toBe('qwen-image-2.0');
      expect(fetchMapping).toHaveBeenCalledTimes(1);
    });
  });

  describe('information centre path', () => {
    it('resolves from the information centre when the cache is empty', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({ fetchMapping: vi.fn().mockResolvedValue({ 'chat create': 'qwen3.7-max' }) }),
      );

      const model = await resolver.resolve({ command: 'chat create' });

      expect(model).toBe('qwen3.7-max');
    });

    it('persists the freshly fetched mapping', async () => {
      const writeCache = vi.fn();
      const mapping = { 'chat create': 'qwen3.7-max' };
      const resolver = new DefaultModelResolver(
        makeDeps({ fetchMapping: vi.fn().mockResolvedValue(mapping), writeCache }),
      );

      await resolver.resolve({ command: 'chat create' });

      expect(writeCache).toHaveBeenCalledWith(mapping);
    });

    it('composes the task mode into the lookup key', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({
          fetchMapping: vi.fn().mockResolvedValue({ 'video generate:i2v': 'wan2.7-i2v' }),
        }),
      );

      const model = await resolver.resolve({ command: 'video generate', taskMode: 'i2v' });

      expect(model).toBe('wan2.7-i2v');
    });
  });

  describe('unresolvable cases', () => {
    it('asks the user for an explicit model when the information centre fails and no cache exists', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({ fetchMapping: vi.fn().mockRejectedValue(new Error('upstream down')) }),
      );

      await expect(resolver.resolve({ command: 'chat create' })).rejects.toBeInstanceOf(CliError);
    });

    it('uses the argument exit code when it cannot resolve a model', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({ fetchMapping: vi.fn().mockRejectedValue(new Error('upstream down')) }),
      );

      try {
        await resolver.resolve({ command: 'chat create' });
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('names the model flag in the unresolvable message', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({ fetchMapping: vi.fn().mockRejectedValue(new Error('upstream down')) }),
      );

      try {
        await resolver.resolve({ command: 'chat create' });
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect((error as CliError).message).toContain('--model');
      }
    });

    it('errors when the information centre responds without the requested command', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({ fetchMapping: vi.fn().mockResolvedValue({ 'chat create': 'qwen3.7-max' }) }),
      );

      try {
        await resolver.resolve({ command: 'music generate' });
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('does not persist anything when the information centre fails', async () => {
      const writeCache = vi.fn();
      const resolver = new DefaultModelResolver(
        makeDeps({
          fetchMapping: vi.fn().mockRejectedValue(new Error('upstream down')),
          writeCache,
        }),
      );

      await resolver.resolve({ command: 'chat create' }).catch(() => undefined);

      expect(writeCache).not.toHaveBeenCalled();
    });

    it('treats a blank cached value as unusable', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({
          readCache: () => ({ 'chat create': '   ' }),
          fetchMapping: vi.fn().mockRejectedValue(new Error('upstream down')),
        }),
      );

      await expect(resolver.resolve({ command: 'chat create' })).rejects.toBeInstanceOf(CliError);
    });

    it('treats a blank explicit model as absent and resolves the default', async () => {
      const resolver = new DefaultModelResolver(
        makeDeps({ readCache: () => ({ 'chat create': 'qwen3.7-max' }) }),
      );

      const model = await resolver.resolve({ command: 'chat create' }, '   ');

      expect(model).toBe('qwen3.7-max');
    });
  });
});
