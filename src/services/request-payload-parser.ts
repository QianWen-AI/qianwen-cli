/** Tier-3 native passthrough: parses a request body without renaming fields. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import type { ParsedRequest, RequestSource } from '../types/invocation-params.js';

export interface RequestPayloadParserDeps {
  readFile: (path: string) => string;
  readStdin: () => string;
}

function invalid(message: string): CliError {
  return new CliError({
    code: 'INVALID_REQUEST_PAYLOAD',
    message,
    exitCode: EXIT_CODES.INVALID_ARGUMENT,
  });
}

export class RequestPayloadParser {
  constructor(private readonly deps: RequestPayloadParserDeps) {}

  parse(requestFlag: string): ParsedRequest {
    const { raw, source } = this.read(requestFlag);

    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw invalid(`Empty --request payload from ${source}.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw invalid(`--request payload is not valid JSON: ${detail}`);
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalid('--request payload must be a JSON object.');
    }

    return { body: parsed as Record<string, unknown>, source };
  }

  private read(requestFlag: string): { raw: string; source: RequestSource } {
    if (requestFlag === '-') {
      return { raw: this.deps.readStdin(), source: 'stdin' };
    }

    if (requestFlag.startsWith('@')) {
      const path = requestFlag.slice(1);
      if (path.length === 0) {
        throw invalid('--request expects a file path after "@".');
      }
      try {
        return { raw: this.deps.readFile(path), source: 'file' };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw invalid(`Cannot read --request file "${path}": ${detail}`);
      }
    }

    return { raw: requestFlag, source: 'inline' };
  }
}
