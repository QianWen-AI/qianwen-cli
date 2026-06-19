/**
 * Returns true when running inside Windows legacy ConHost (not Windows Terminal).
 */
export function isConHost(): boolean {
  return process.platform === 'win32' && !process.env.WT_SESSION && !process.env.TERM_PROGRAM;
}
