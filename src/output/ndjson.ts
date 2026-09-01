/** Newline-delimited JSON sink for streaming model invocations. */

export interface NdjsonWriterDeps {
  write: (line: string) => void;
}

export interface NdjsonTrailer {
  request_id?: string;
  model?: string;
  finish_reason?: string;
  usage?: Record<string, unknown>;
}

export class NdjsonWriter {
  constructor(private readonly deps: NdjsonWriterDeps) {}

  writeLine(payload: Record<string, unknown>): void {
    this.deps.write(JSON.stringify(payload) + '\n');
  }

  /** Final NDJSON line: `{"meta":{...}}` with request_id/model/finish_reason/usage. */
  writeTrailer(meta: NdjsonTrailer): void {
    const trailer: NdjsonTrailer = {};
    if (meta.request_id !== undefined) trailer.request_id = meta.request_id;
    if (meta.model !== undefined) trailer.model = meta.model;
    if (meta.finish_reason !== undefined) trailer.finish_reason = meta.finish_reason;
    if (meta.usage !== undefined) trailer.usage = meta.usage;
    this.deps.write(JSON.stringify({ meta: trailer }) + '\n');
  }
}
