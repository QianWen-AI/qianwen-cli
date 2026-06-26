const HELP_TOKENS = new Set(['-h', '--help']);

/**
 * A value-taking option followed directly by -h/--help makes Commander swallow
 * the help flag as that option's value. Detect such a value so the command can
 * show help instead of treating it as input.
 */
export function isHelpRequest(...values: unknown[]): boolean {
  return values.some((v) => typeof v === 'string' && HELP_TOKENS.has(v));
}
