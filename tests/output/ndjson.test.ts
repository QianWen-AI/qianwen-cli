/**
 * Unit tests for NdjsonWriter — the newline-delimited JSON sink used by
 * streaming model invocations.
 *
 * Per specification each payload occupies exactly one line of compact JSON, and
 * the stream is terminated by a trailer line carrying the request identifier and
 * token usage. Absent trailer values must be omitted rather than serialized as
 * null, and the structure never varies with the attached terminal.
 */
import { describe, it, expect, vi } from 'vitest';
import { NdjsonWriter, type NdjsonWriterDeps } from '../../src/output/ndjson.js';
import type { TokenUsage } from '../../src/types/model-invocation.js';

const USAGE: TokenUsage = { input: 11, output: 22, total: 33 };

/** Collect every string handed to the writer's sink. */
function makeSink(): { deps: NdjsonWriterDeps; lines: string[]; write: ReturnType<typeof vi.fn> } {
  const lines: string[] = [];
  const write = vi.fn((line: string) => {
    lines.push(line);
  });
  return { deps: { write }, lines, write };
}

/** Parse the sink output as a sequence of NDJSON records. */
function parseRecords(lines: string[]): unknown[] {
  return lines
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe('NdjsonWriter', () => {
  describe('writeLine', () => {
    it('serializes a payload as compact JSON', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeLine({ type: 'content', content: 'hello' });

      expect(lines[0]).toBe('{"type":"content","content":"hello"}\n');
    });

    it('terminates each payload with a single newline', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeLine({ type: 'done' });

      expect(lines[0]!.endsWith('}\n')).toBe(true);
      expect(lines[0]!.match(/\n/g)).toHaveLength(1);
    });

    it('emits one sink call per payload', () => {
      const { deps, write } = makeSink();
      const writer = new NdjsonWriter(deps);

      writer.writeLine({ a: 1 });
      writer.writeLine({ b: 2 });

      expect(write).toHaveBeenCalledTimes(2);
    });

    it('keeps successive payloads on separate lines', () => {
      const { deps, lines } = makeSink();
      const writer = new NdjsonWriter(deps);

      writer.writeLine({ seq: 1 });
      writer.writeLine({ seq: 2 });
      writer.writeLine({ seq: 3 });

      expect(parseRecords(lines)).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    });

    it('does not introduce indentation whitespace', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeLine({ outer: { inner: [1, 2] } });

      expect(lines[0]).toBe('{"outer":{"inner":[1,2]}}\n');
    });

    it('escapes an embedded newline so the record stays on one line', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeLine({ content: 'a\nb' });

      expect(lines[0]!.match(/\n/g)).toHaveLength(1);
      expect(parseRecords(lines)).toEqual([{ content: 'a\nb' }]);
    });

    it('preserves non-ASCII content without escaping it away', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeLine({ content: '量子计算' });

      expect(parseRecords(lines)).toEqual([{ content: '量子计算' }]);
    });

    it('writes an empty payload as an empty JSON object', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeLine({});

      expect(lines[0]).toBe('{}\n');
    });
  });

  describe('writeTrailer', () => {
    it('nests the trailer under a meta key', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeTrailer({ request_id: 'req-1' });

      expect(parseRecords(lines)).toEqual([{ meta: { request_id: 'req-1' } }]);
    });

    it('carries both the request identifier and the usage block', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeTrailer({ request_id: 'req-1', usage: USAGE });

      expect(parseRecords(lines)).toEqual([{ meta: { request_id: 'req-1', usage: USAGE } }]);
    });

    it('omits the request identifier key when no identifier is known', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeTrailer({ usage: USAGE });

      const meta = (parseRecords(lines)[0] as { meta: Record<string, unknown> }).meta;
      expect('request_id' in meta).toBe(false);
    });

    it('omits the usage key when usage is unavailable', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeTrailer({ request_id: 'req-1' });

      const meta = (parseRecords(lines)[0] as { meta: Record<string, unknown> }).meta;
      expect('usage' in meta).toBe(false);
    });

    it('still emits an empty meta object when nothing is known', () => {
      const { deps, lines } = makeSink();

      new NdjsonWriter(deps).writeTrailer({});

      expect(lines[0]).toBe('{"meta":{}}\n');
    });

    it('writes the trailer as the final line after content lines', () => {
      const { deps, lines } = makeSink();
      const writer = new NdjsonWriter(deps);

      writer.writeLine({ type: 'content', content: 'hi' });
      writer.writeTrailer({ request_id: 'req-9', usage: USAGE });

      const records = parseRecords(lines);
      expect(records).toHaveLength(2);
      expect(records[1]).toEqual({ meta: { request_id: 'req-9', usage: USAGE } });
    });

    it('preserves a zeroed usage block rather than dropping falsy counters', () => {
      const { deps, lines } = makeSink();
      const zero: TokenUsage = { input: 0, output: 0, total: 0 };

      new NdjsonWriter(deps).writeTrailer({ usage: zero });

      expect(parseRecords(lines)).toEqual([{ meta: { usage: zero } }]);
    });
  });
});
