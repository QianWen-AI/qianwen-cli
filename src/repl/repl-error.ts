import { HandledError } from '../utils/errors.js';

// Commander's writeErr is globally silenced in cli.ts so one-shot mode can
// surface errors as structured output; the REPL must echo them itself.
export function surfaceCommanderError(err: {
  code?: string;
  message?: string;
  exitCode?: number;
}): string | null {
  if (typeof err.code === 'string' && err.code.startsWith('commander.') && err.message) {
    return err.message.replace(/^error:\s*/i, '');
  }
  return null;
}

// HandledError is the "message already printed; only the exit code matters"
// sentinel. A command throws it after rendering its own output, so the REPL
// must swallow it (continue silently) for any exit code — including success
// (e.g. an already-rated ticket) — rather than coercing it into "Error:".
export function shouldSwallowReplError(err: unknown): boolean {
  return err instanceof HandledError;
}
