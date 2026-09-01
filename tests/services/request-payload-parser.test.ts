/**
 * Unit tests for RequestPayloadParser — the tier-3 native passthrough parser.
 *
 * Per specification the parser accepts three sources: `@path` reads a file,
 * `-` reads stdin, and anything else is treated as inline JSON. Field names and
 * nested structure are preserved 1:1 — no renaming, no injected defaults.
 * Malformed JSON, a non-object top level, and empty input are argument errors.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  RequestPayloadParser,
  type RequestPayloadParserDeps,
} from '../../src/services/request-payload-parser.js';
import { CliError } from '../../src/utils/errors.js';
import { EXIT_CODES } from '../../src/utils/exit-codes.js';

function makeDeps(overrides: Partial<RequestPayloadParserDeps> = {}): RequestPayloadParserDeps {
  return {
    readFile: () => {
      throw new Error('readFile not stubbed');
    },
    readStdin: () => {
      throw new Error('readStdin not stubbed');
    },
    ...overrides,
  };
}

describe('RequestPayloadParser', () => {
  describe('source selection', () => {
    it('parses inline JSON and reports the inline source', () => {
      const parser = new RequestPayloadParser(makeDeps());

      const result = parser.parse('{"model":"qwen3.7-max","temperature":0.7}');

      expect(result.source).toBe('inline');
      expect(result.body).toEqual({ model: 'qwen3.7-max', temperature: 0.7 });
    });

    it('reads from a file when the value starts with @ and reports the file source', () => {
      const readFile = vi.fn().mockReturnValue('{"input":{"prompt":"a cat"}}');
      const parser = new RequestPayloadParser(makeDeps({ readFile }));

      const result = parser.parse('@payload.json');

      expect(readFile).toHaveBeenCalledWith('payload.json');
      expect(result.source).toBe('file');
      expect(result.body).toEqual({ input: { prompt: 'a cat' } });
    });

    it('reads from stdin when the value is a single dash and reports the stdin source', () => {
      const readStdin = vi.fn().mockReturnValue('{"parameters":{"size":"1024*1024"}}');
      const parser = new RequestPayloadParser(makeDeps({ readStdin }));

      const result = parser.parse('-');

      expect(readStdin).toHaveBeenCalledTimes(1);
      expect(result.source).toBe('stdin');
      expect(result.body).toEqual({ parameters: { size: '1024*1024' } });
    });

    it('does not consult stdin when parsing inline JSON', () => {
      const readStdin = vi.fn().mockReturnValue('{"unused":true}');
      const parser = new RequestPayloadParser(makeDeps({ readStdin }));

      parser.parse('{"model":"m"}');

      expect(readStdin).not.toHaveBeenCalled();
    });

    it('does not consult the filesystem when parsing inline JSON', () => {
      const readFile = vi.fn().mockReturnValue('{"unused":true}');
      const parser = new RequestPayloadParser(makeDeps({ readFile }));

      parser.parse('{"model":"m"}');

      expect(readFile).not.toHaveBeenCalled();
    });

    it('treats an @ followed by a path containing directories as a file read', () => {
      const readFile = vi.fn().mockReturnValue('{"a":1}');
      const parser = new RequestPayloadParser(makeDeps({ readFile }));

      parser.parse('@./fixtures/nested/body.json');

      expect(readFile).toHaveBeenCalledWith('./fixtures/nested/body.json');
    });
  });

  describe('1:1 structural fidelity', () => {
    it('preserves deeply nested structure without renaming keys', () => {
      const parser = new RequestPayloadParser(makeDeps());
      const raw = {
        model: 'wan2.7-i2v',
        input: {
          prompt: 'sunrise',
          media: [{ type: 'first_frame', url: 'https://mock-api.test.qianwenai.com/a.png' }],
        },
        parameters: { resolution: '1080P', prompt_extend: true },
      };

      const result = parser.parse(JSON.stringify(raw));

      expect(result.body).toEqual(raw);
    });

    it('preserves snake_case keys verbatim', () => {
      const parser = new RequestPayloadParser(makeDeps());

      const result = parser.parse('{"max_completion_tokens":512,"enable_thinking":false}');

      expect(Object.keys(result.body).sort()).toEqual([
        'enable_thinking',
        'max_completion_tokens',
      ]);
    });

    it('does not inject any default fields', () => {
      const parser = new RequestPayloadParser(makeDeps());

      const result = parser.parse('{"model":"qwen3.7-max"}');

      expect(Object.keys(result.body)).toEqual(['model']);
    });

    it('preserves empty nested containers', () => {
      const parser = new RequestPayloadParser(makeDeps());

      const result = parser.parse('{"input":{},"parameters":[]}');

      expect(result.body).toEqual({ input: {}, parameters: [] });
    });

    it('preserves explicit null values rather than dropping them', () => {
      const parser = new RequestPayloadParser(makeDeps());

      const result = parser.parse('{"seed":null}');

      expect(result.body).toHaveProperty('seed', null);
    });

    it('preserves numeric precision of floating point values', () => {
      const parser = new RequestPayloadParser(makeDeps());

      const result = parser.parse('{"temperature":0.15}');

      expect(result.body.temperature).toBe(0.15);
    });
  });

  describe('argument errors', () => {
    it('rejects malformed JSON with an argument exit code', () => {
      const parser = new RequestPayloadParser(makeDeps());

      expect(() => parser.parse('{"model":')).toThrow(CliError);
      try {
        parser.parse('{"model":');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('rejects a JSON array top level', () => {
      const parser = new RequestPayloadParser(makeDeps());

      try {
        parser.parse('[{"model":"m"}]');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('rejects a JSON scalar top level', () => {
      const parser = new RequestPayloadParser(makeDeps());

      try {
        parser.parse('42');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('rejects a JSON null top level', () => {
      const parser = new RequestPayloadParser(makeDeps());

      try {
        parser.parse('null');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('rejects an empty inline value', () => {
      const parser = new RequestPayloadParser(makeDeps());

      try {
        parser.parse('');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('rejects a blank stdin payload', () => {
      const parser = new RequestPayloadParser(makeDeps({ readStdin: () => '   \n  ' }));

      try {
        parser.parse('-');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('rejects an empty file payload', () => {
      const parser = new RequestPayloadParser(makeDeps({ readFile: () => '' }));

      try {
        parser.parse('@empty.json');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('rejects an @ with no path after it', () => {
      const parser = new RequestPayloadParser(makeDeps());

      try {
        parser.parse('@');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('surfaces a file read failure as a CliError rather than a raw exception', () => {
      const parser = new RequestPayloadParser(
        makeDeps({
          readFile: () => {
            throw new Error('ENOENT: no such file or directory');
          },
        }),
      );

      try {
        parser.parse('@missing.json');
        expect.unreachable('expected a CliError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT_CODES.INVALID_ARGUMENT);
      }
    });

    it('tolerates surrounding whitespace around otherwise valid JSON', () => {
      const parser = new RequestPayloadParser(makeDeps());

      const result = parser.parse('  \n {"model":"m"} \n ');

      expect(result.body).toEqual({ model: 'm' });
    });
  });
});
