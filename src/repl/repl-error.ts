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
