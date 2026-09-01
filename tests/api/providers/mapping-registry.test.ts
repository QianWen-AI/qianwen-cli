/**
 * Unit tests for MappingRegistry.
 *
 * Per architecture design a mapping entry is keyed by the combination of
 * command, wire protocol, model family and task mode. A lookup miss must never
 * be papered over by guessing field names: the strict accessor raises an
 * argument error and points the user at the native passthrough flag. The same
 * applies to a convenience flag that has no template in the matched entry.
 */
import { describe, it, expect } from 'vitest';
import {
  MappingRegistry,
  type MappingEntry,
  type MappingKey,
} from '../../../src/api/providers/mapping-registry.js';
import { CliError } from '../../../src/utils/errors.js';
import { EXIT_CODES } from '../../../src/utils/exit-codes.js';

const CHAT_KEY: MappingKey = {
  command: 'chat create',
  protocol: 'openai-compatible',
  modelFamily: 'qwen-max',
  taskMode: 'text',
};

function makeEntry(overrides: Partial<MappingEntry> = {}): MappingEntry {
  return {
    key: CHAT_KEY,
    fieldTemplates: {
      '--temperature': 'temperature',
      '--max-tokens': 'max_completion_tokens',
    },
    capabilities: { streaming: true, asynchronous: false },
    filePolicy: { allowBase64: true, allowTempUpload: false },
    ...overrides,
  };
}

describe('MappingRegistry', () => {
  describe('lookup', () => {
    it('returns a registered entry for an exactly matching key', () => {
      const registry = new MappingRegistry();
      const entry = makeEntry();
      registry.register(entry);

      const found = registry.lookup(CHAT_KEY);

      expect(found?.fieldTemplates['--temperature']).toBe('temperature');
    });

    it('returns null for an unregistered key', () => {
      const registry = new MappingRegistry();

      expect(registry.lookup(CHAT_KEY)).toBeNull();
    });

    it('does not match when the protocol differs', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      const found = registry.lookup({ ...CHAT_KEY, protocol: 'dashscope-native' });

      expect(found).toBeNull();
    });

    it('does not match when the model family differs', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      const found = registry.lookup({ ...CHAT_KEY, modelFamily: 'qwen-vl' });

      expect(found).toBeNull();
    });

    it('does not match when the task mode differs', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      const found = registry.lookup({ ...CHAT_KEY, taskMode: 'vision' });

      expect(found).toBeNull();
    });

    it('does not match when the command differs', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      const found = registry.lookup({ ...CHAT_KEY, command: 'image generate' });

      expect(found).toBeNull();
    });

    it('keeps entries that differ only by task mode independently addressable', () => {
      const registry = new MappingRegistry();
      const t2v: MappingKey = {
        command: 'video generate',
        protocol: 'dashscope-native',
        modelFamily: 'wan',
        taskMode: 't2v',
      };
      const i2v: MappingKey = { ...t2v, taskMode: 'i2v' };
      registry.register(makeEntry({ key: t2v, fieldTemplates: { '--size': 'parameters.size' } }));
      registry.register(
        makeEntry({ key: i2v, fieldTemplates: { '--image': 'input.media' } }),
      );

      expect(registry.lookup(t2v)?.fieldTemplates['--size']).toBe('parameters.size');
      expect(registry.lookup(i2v)?.fieldTemplates['--image']).toBe('input.media');
    });

    it('lets a later registration replace an identical key', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry({ fieldTemplates: { '--temperature': 'temperature' } }));
      registry.register(
        makeEntry({ fieldTemplates: { '--temperature': 'parameters.temperature' } }),
      );

      expect(registry.lookup(CHAT_KEY)?.fieldTemplates['--temperature']).toBe(
        'parameters.temperature',
      );
    });

    it('preserves the capability descriptor of a registered entry', () => {
      const registry = new MappingRegistry();
      registry.register(
        makeEntry({ capabilities: { streaming: false, asynchronous: true } }),
      );

      expect(registry.lookup(CHAT_KEY)?.capabilities).toEqual({
        streaming: false,
        asynchronous: true,
      });
    });

    it('preserves the file policy of a registered entry', () => {
      const registry = new MappingRegistry();
      registry.register(
        makeEntry({ filePolicy: { allowBase64: false, allowTempUpload: true } }),
      );

      expect(registry.lookup(CHAT_KEY)?.filePolicy).toEqual({
        allowBase64: false,
        allowTempUpload: true,
      });
    });
  });

  describe('require', () => {
    it('returns the entry when the key is registered', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      expect(registry.require(CHAT_KEY).key).toEqual(CHAT_KEY);
    });

    it('raises an argument error for an unknown mapping', () => {
      const registry = new MappingRegistry();

      try {
        registry.require(CHAT_KEY);
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('points the user at the native passthrough flag when the mapping is unknown', () => {
      const registry = new MappingRegistry();

      try {
        registry.require(CHAT_KEY);
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect((error as CliError).message).toContain('--request');
      }
    });

    it('identifies the unmatched model family in the error message', () => {
      const registry = new MappingRegistry();

      try {
        registry.require({ ...CHAT_KEY, modelFamily: 'mystery-family' });
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect((error as CliError).message).toContain('mystery-family');
      }
    });
  });

  describe('requireFieldPath', () => {
    it('returns the native field path for a mapped convenience flag', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      expect(registry.requireFieldPath(CHAT_KEY, '--temperature')).toBe('temperature');
    });

    it('returns the nested native path when the template is nested', () => {
      const registry = new MappingRegistry();
      registry.register(
        makeEntry({ fieldTemplates: { '--temperature': 'parameters.temperature' } }),
      );

      expect(registry.requireFieldPath(CHAT_KEY, '--temperature')).toBe('parameters.temperature');
    });

    it('raises an argument error for a flag with no template in the matched entry', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      try {
        registry.requireFieldPath(CHAT_KEY, '--texture-quality');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('names the unsupported flag in the error message', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      try {
        registry.requireFieldPath(CHAT_KEY, '--texture-quality');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect((error as CliError).message).toContain('--texture-quality');
      }
    });

    it('points the user at the native passthrough flag for an unmapped convenience flag', () => {
      const registry = new MappingRegistry();
      registry.register(makeEntry());

      try {
        registry.requireFieldPath(CHAT_KEY, '--texture-quality');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect((error as CliError).message).toContain('--request');
      }
    });

    it('raises an argument error when the mapping itself is unknown', () => {
      const registry = new MappingRegistry();

      try {
        registry.requireFieldPath(CHAT_KEY, '--temperature');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });
  });
});
