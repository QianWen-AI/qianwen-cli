import { exec } from 'child_process';

/**
 * Open a URL in the user's default browser.
 *
 * Resolves to `true` when the platform open command exits successfully, and
 * `false` when it fails to launch (non-zero exit, missing command, or a
 * sandboxed/headless environment where the browser cannot be opened). Never
 * rejects — callers should still offer the URL for manual copy regardless of
 * the result.
 */
export function openBrowser(url: string): Promise<boolean> {
  const cmd =
    process.platform === 'darwin'
      ? `open ${JSON.stringify(url)}`
      : process.platform === 'win32'
        ? `start "" ${JSON.stringify(url)}`
        : `xdg-open ${JSON.stringify(url)}`;

  return new Promise((resolve) => {
    try {
      exec(cmd, (error) => {
        // `error` is set on non-zero exit or when the command cannot be
        // spawned (e.g. xdg-open missing, or a sandbox denies launching it).
        resolve(!error);
      });
    } catch {
      // Synchronous spawn failure — treat as "could not open".
      resolve(false);
    }
  });
}
