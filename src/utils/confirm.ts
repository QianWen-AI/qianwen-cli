/** Interactive y/N confirmation prompt. Resolves false in non-TTY or on any non-'y' answer. */
import { createInterface } from 'readline';

type PromptInterface = { question(query: string, cb: (answer: string) => void): void };

let activePromptInterface: PromptInterface | null = null;

/** Register an interactive readline so confirmation prompts route through it. */
export function setActivePromptInterface(rl: PromptInterface): void {
  activePromptInterface = rl;
}

export function clearActivePromptInterface(): void {
  activePromptInterface = null;
}

export async function confirmPrompt(message: string): Promise<boolean> {
  // Reuse an already-active interactive interface when one is registered.
  // Routing the question through it keeps the answer from being parsed as a
  // command, and the active registration itself implies interactive mode.
  if (activePromptInterface) {
    return new Promise<boolean>((resolve) =>
      activePromptInterface!.question(`${message} `, (answer) =>
        resolve(answer.trim().toLowerCase() === 'y'),
      ),
    );
  }

  // Non-TTY environments cannot prompt; treat as cancellation.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    // A preceding interactive step (Ink renderInteractive) may have left stdin
    // paused + unref'd in one-shot mode. Re-ref + resume so the event loop stays
    // alive while waiting for the answer; otherwise the loop drains and Node
    // reports an unsettled top-level await before the prompt is answered.
    process.stdin.ref();
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
      // Release stdin so the process can exit naturally after this final
      // interactive step (confirmPrompt is the last prompt in one-shot flows).
      try {
        process.stdin.pause();
      } catch {
        // ignore environments that disallow pausing stdin
      }
      process.stdin.unref();
      resolve(value);
    };

    rl.on('SIGINT', () => finish(false));
    rl.on('close', () => finish(false));

    rl.question(`${message} `, (answer) => {
      finish(answer.trim().toLowerCase() === 'y');
    });
  });
}
