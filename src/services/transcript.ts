/** Fetches and shapes the Fun-ASR result JSON that a transcription task URL points to. */

export const TRANSCRIPT_PREVIEW_LIMIT = 200;

export interface TranscriptPreview {
  text: string;
  truncated: boolean;
  limit: number;
}

/** Join the per-channel `transcripts[].text` fields of a Fun-ASR result JSON. */
export function extractTranscriptText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const transcripts = (payload as Record<string, unknown>).transcripts;
  if (!Array.isArray(transcripts)) return undefined;
  const parts = transcripts
    .map((item) =>
      item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
        ? (item as { text: string }).text
        : '',
    )
    .filter((t) => t.length > 0);
  if (parts.length === 0) return undefined;
  return parts.join('\n');
}

/** Cap a transcript to `limit` characters, flagging whether it was cut. */
export function previewTranscript(
  text: string,
  limit = TRANSCRIPT_PREVIEW_LIMIT,
): TranscriptPreview {
  const chars = [...text];
  if (chars.length <= limit) return { text, truncated: false, limit };
  return { text: chars.slice(0, limit).join(''), truncated: true, limit };
}

export interface TranscriptFetcherDeps {
  fetchText: (url: string) => Promise<string>;
}

export class TranscriptFetcher {
  constructor(private readonly deps: TranscriptFetcherDeps) {}

  /**
   * Fetch the result JSON at `url` and return a character-capped preview. Returns
   * undefined when the fetch or parse fails so callers fall back to the URL alone.
   */
  async preview(
    url: string,
    limit = TRANSCRIPT_PREVIEW_LIMIT,
  ): Promise<TranscriptPreview | undefined> {
    let raw: string;
    try {
      raw = await this.deps.fetchText(url);
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const text = extractTranscriptText(parsed);
    if (text === undefined) return undefined;
    return previewTranscript(text, limit);
  }
}
