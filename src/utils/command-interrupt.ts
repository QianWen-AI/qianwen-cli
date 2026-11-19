type CommandInterruptHandler = () => void;

const activeRegistrations: Array<{ handler: CommandInterruptHandler }> = [];

/**
 * Register the interrupt handler for the currently running cancellable command.
 *
 * @param handler Command-specific cancellation callback.
 * @returns Idempotent cleanup that removes only this registration.
 */
export function registerCommandInterrupt(handler: CommandInterruptHandler): () => void {
  const registration = { handler };
  activeRegistrations.push(registration);
  return () => {
    const index = activeRegistrations.indexOf(registration);
    if (index !== -1) activeRegistrations.splice(index, 1);
  };
}

/** Dispatch Ctrl+C to the active command when one has registered cancellation. */
export function interruptActiveCommand(): boolean {
  const active = activeRegistrations.at(-1);
  if (!active) return false;
  active.handler();
  return true;
}
