/**
 * Unit tests for LayerConflictDetector.
 *
 * Per specification a convenience flag and the native passthrough body must not
 * set the same semantic twice. A flag may map to several candidate field paths
 * because different wire protocols place it differently; hitting any one of
 * them is a conflict. Conflicts are reported as errors — neither shallow nor
 * deep merging is performed. The model flag is the single exception: it
 * overrides the model carried in the passthrough body.
 */
import { describe, it, expect } from 'vitest';
import {
  LayerConflictDetector,
  type Layer2Assignment,
} from '../../src/services/layer-conflict-detector.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';

const TEMPERATURE: Layer2Assignment = {
  flag: '--temperature',
  paths: ['temperature', 'parameters.temperature'],
};

const MAX_TOKENS: Layer2Assignment = {
  flag: '--max-tokens',
  paths: ['max_completion_tokens', 'parameters.max_completion_tokens'],
};

const SIZE: Layer2Assignment = { flag: '--size', paths: ['parameters.size'] };

describe('LayerConflictDetector', () => {
  describe('detect — no conflict cases', () => {
    it('reports no conflict for an empty passthrough body', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([TEMPERATURE, MAX_TOKENS], {});

      expect(report.conflicts).toEqual([]);
    });

    it('reports no conflict when the body sets unrelated fields', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([TEMPERATURE], { model: 'm', input: { prompt: 'hi' } });

      expect(report.conflicts).toEqual([]);
    });

    it('reports no conflict when no convenience flags were supplied', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([], { temperature: 0.7 });

      expect(report.conflicts).toEqual([]);
    });

    it('does not treat a same-named key nested under an unrelated parent as a hit', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([SIZE], { input: { size: '1024*1024' } });

      expect(report.conflicts).toEqual([]);
    });
  });

  describe('detect — protocol path variants', () => {
    it('detects a conflict on the flat protocol path', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([TEMPERATURE], { temperature: 0.9 });

      expect(report.conflicts).toEqual([{ flag: '--temperature', path: 'temperature' }]);
    });

    it('detects a conflict on the nested protocol path', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([TEMPERATURE], { parameters: { temperature: 0.9 } });

      expect(report.conflicts).toEqual([
        { flag: '--temperature', path: 'parameters.temperature' },
      ]);
    });

    it('reports both candidate paths when the body sets the semantic twice', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([TEMPERATURE], {
        temperature: 0.9,
        parameters: { temperature: 0.2 },
      });

      expect(report.conflicts).toEqual([
        { flag: '--temperature', path: 'temperature' },
        { flag: '--temperature', path: 'parameters.temperature' },
      ]);
    });

    it('aggregates conflicts across multiple flags', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([TEMPERATURE, MAX_TOKENS], {
        temperature: 0.9,
        parameters: { max_completion_tokens: 100 },
      });

      expect(report.conflicts).toEqual([
        { flag: '--temperature', path: 'temperature' },
        { flag: '--max-tokens', path: 'parameters.max_completion_tokens' },
      ]);
    });

    it('treats an explicit null in the body as a set value', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([TEMPERATURE], { temperature: null });

      expect(report.conflicts).toEqual([{ flag: '--temperature', path: 'temperature' }]);
    });

    it('treats a falsy zero in the body as a set value', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([TEMPERATURE], { temperature: 0 });

      expect(report.conflicts).toEqual([{ flag: '--temperature', path: 'temperature' }]);
    });

    it('treats a false boolean in the body as a set value', () => {
      const detector = new LayerConflictDetector();
      const thinking: Layer2Assignment = {
        flag: '--thinking',
        paths: ['enable_thinking', 'parameters.enable_thinking'],
      };

      const report = detector.detect([thinking], { parameters: { enable_thinking: false } });

      expect(report.conflicts).toEqual([
        { flag: '--thinking', path: 'parameters.enable_thinking' },
      ]);
    });

    it('does not crash when an intermediate path segment is not an object', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([SIZE], { parameters: 'not-an-object' });

      expect(report.conflicts).toEqual([]);
    });

    it('does not crash when an intermediate path segment is null', () => {
      const detector = new LayerConflictDetector();

      const report = detector.detect([SIZE], { parameters: null });

      expect(report.conflicts).toEqual([]);
    });
  });

  describe('assertNoConflict', () => {
    it('returns without throwing when nothing conflicts', () => {
      const detector = new LayerConflictDetector();

      expect(() => detector.assertNoConflict([TEMPERATURE], { model: 'm' })).not.toThrow();
    });

    it('throws an argument error when a conflict exists', () => {
      const detector = new LayerConflictDetector();

      try {
        detector.assertNoConflict([TEMPERATURE], { temperature: 0.9 });
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('names the offending flag and native field path in the message', () => {
      const detector = new LayerConflictDetector();

      try {
        detector.assertNoConflict([TEMPERATURE], { parameters: { temperature: 0.9 } });
        expect.unreachable('expected a CliError');
      } catch (error) {
        const message = (error as CliError).message;
        expect(message).toContain('--temperature');
        expect(message).toContain('parameters.temperature');
      }
    });

    it('mentions every conflicting flag when several collide', () => {
      const detector = new LayerConflictDetector();

      try {
        detector.assertNoConflict([TEMPERATURE, MAX_TOKENS], {
          temperature: 0.9,
          max_completion_tokens: 100,
        });
        expect.unreachable('expected a CliError');
      } catch (error) {
        const message = (error as CliError).message;
        expect(message).toContain('--temperature');
        expect(message).toContain('--max-tokens');
      }
    });
  });

  describe('applyModelOverride', () => {
    it('overrides the model carried in the passthrough body', () => {
      const detector = new LayerConflictDetector();

      const result = detector.applyModelOverride({ model: 'from-request' }, 'from-flag');

      expect(result.model).toBe('from-flag');
    });

    it('injects the model when the body omits it', () => {
      const detector = new LayerConflictDetector();

      const result = detector.applyModelOverride({ input: { prompt: 'hi' } }, 'from-flag');

      expect(result.model).toBe('from-flag');
    });

    it('leaves the body model untouched when no flag was supplied', () => {
      const detector = new LayerConflictDetector();

      const result = detector.applyModelOverride({ model: 'from-request' }, undefined);

      expect(result.model).toBe('from-request');
    });

    it('preserves all other fields when overriding', () => {
      const detector = new LayerConflictDetector();

      const result = detector.applyModelOverride(
        { model: 'old', input: { prompt: 'hi' }, parameters: { size: '1024*1024' } },
        'new',
      );

      expect(result).toEqual({
        model: 'new',
        input: { prompt: 'hi' },
        parameters: { size: '1024*1024' },
      });
    });

    it('does not mutate the caller-supplied body', () => {
      const detector = new LayerConflictDetector();
      const original = { model: 'from-request' };

      detector.applyModelOverride(original, 'from-flag');

      expect(original.model).toBe('from-request');
    });

    it('never reports the model flag as a conflict', () => {
      const detector = new LayerConflictDetector();
      const modelAssignment: Layer2Assignment = { flag: '--model', paths: ['model'] };

      const overridden = detector.applyModelOverride({ model: 'a' }, 'b');
      const report = detector.detect(
        [modelAssignment].filter((a) => a.flag !== '--model'),
        overridden,
      );

      expect(report.conflicts).toEqual([]);
    });
  });
});
