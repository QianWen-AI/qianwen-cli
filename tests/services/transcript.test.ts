import { describe, it, expect } from 'vitest';
import {
  extractTranscriptText,
  previewTranscript,
  TranscriptFetcher,
  TRANSCRIPT_PREVIEW_LIMIT,
} from '../../src/services/transcript.js';

describe('extractTranscriptText', () => {
  it('joins the text of each transcript channel', () => {
    const text = extractTranscriptText({
      transcripts: [{ text: 'channel one' }, { text: 'channel two' }],
    });
    expect(text).toBe('channel one\nchannel two');
  });

  it('returns undefined when there are no transcripts', () => {
    expect(extractTranscriptText({ transcripts: [] })).toBeUndefined();
    expect(extractTranscriptText({})).toBeUndefined();
    expect(extractTranscriptText('nope')).toBeUndefined();
  });
});

describe('previewTranscript', () => {
  it('keeps text within the limit intact', () => {
    const preview = previewTranscript('short');
    expect(preview.truncated).toBe(false);
    expect(preview.text).toBe('short');
    expect(preview.limit).toBe(TRANSCRIPT_PREVIEW_LIMIT);
  });

  it('caps by character count, not code units', () => {
    const preview = previewTranscript('字'.repeat(250));
    expect(preview.truncated).toBe(true);
    expect([...preview.text]).toHaveLength(200);
  });
});

describe('TranscriptFetcher.preview', () => {
  it('fetches, parses, and previews the result JSON', async () => {
    const fetcher = new TranscriptFetcher({
      fetchText: async () => JSON.stringify({ transcripts: [{ text: 'hello world' }] }),
    });
    const preview = await fetcher.preview('https://example.test.qianwenai.com/r.json');
    expect(preview?.text).toBe('hello world');
    expect(preview?.truncated).toBe(false);
  });

  it('returns undefined when the fetch throws', async () => {
    const fetcher = new TranscriptFetcher({
      fetchText: async () => {
        throw new Error('boom');
      },
    });
    expect(await fetcher.preview('https://example.test.qianwenai.com/r.json')).toBeUndefined();
  });

  it('returns undefined when the body is not valid JSON', async () => {
    const fetcher = new TranscriptFetcher({ fetchText: async () => 'not json' });
    expect(await fetcher.preview('https://example.test.qianwenai.com/r.json')).toBeUndefined();
  });
});
