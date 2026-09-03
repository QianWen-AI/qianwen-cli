type CommandInterruptHandler = () => void;

let activeHandler: CommandInterruptHandler | undefined;

/**
 * Register the interrupt handler for the currently running cancellable command.
 *
 * @param handler Command-specific cancellation callback.
 * @returns Cleanup that restores the previous handler without clearing a newer one.
 */
export function registerCommandInterrupt(handler: CommandInterruptHandler): () => void {
  const previous = activeHandler;
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = previous;
  };
}

/** Dispatch Ctrl+C to the active command when one has registered cancellation. */
export function interruptActiveCommand(): boolean {
  if (!activeHandler) return false;
  activeHandler();
  return true;
}
