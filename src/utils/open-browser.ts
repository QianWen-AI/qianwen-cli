import { exec } from 'child_process';

/**
 * Open a URL in the user's default browser.
 * Fails silently — callers should always offer the URL for manual copy.
 */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open ${JSON.stringify(url)}`
      : process.platform === 'win32'
        ? `start "" ${JSON.stringify(url)}`
        : `xdg-open ${JSON.stringify(url)}`;

  exec(cmd, () => {
    // Intentional no-op: the URL is surfaced to the user separately.
  });
}
