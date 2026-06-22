/** Interactive y/N confirmation prompt. Resolves false in non-TTY or on any non-'y' answer. */
import { createInterface } from 'readline';

export async function confirmPrompt(message: string): Promise<boolean> {
  // Non-TTY environments cannot prompt; treat as cancellation.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    if (process.stdin.isPaused()) {
      process.stdin.resume();
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let settled = false;

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {
        // ignore double-close
      }
      resolve(value);
    };

    rl.on('SIGINT', () => finish(false));
    rl.on('close', () => finish(false));

    rl.question(`${message} `, (answer) => {
      finish(answer.trim().toLowerCase() === 'y');
    });
  });
}
