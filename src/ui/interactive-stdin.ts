import { PassThrough } from 'node:stream';
import { attemptTerminalCleanup } from '../utils/stdin-control.js';

/**
 * Preserve Ink's direct readable-input path while isolating terminal control
 * failures. Ink must reach its own listener cleanup and exit notification even
 * when a physical TTY operation throws during unmount.
 */
export function createGuardedStdin(source: NodeJS.ReadStream): {
  stdin: NodeJS.ReadStream;
  restore: () => void;
} {
  let active = true;
  let pendingRawDisable: ReturnType<typeof setImmediate> | undefined;
  const applyControl = (name: string, args: unknown[]) => {
    attemptTerminalCleanup(() => Reflect.apply(Reflect.get(source, name), source, args));
  };
  const controls = new Map<PropertyKey, (...args: unknown[]) => NodeJS.ReadStream>();
  for (const name of ['setRawMode', 'ref', 'unref', 'resume', 'pause']) {
    controls.set(name, (...args: unknown[]) => {
      if (!active) return stdin;
      if (name === 'setRawMode' && args[0] === true && pendingRawDisable) {
        clearImmediate(pendingRawDisable);
        pendingRawDisable = undefined;
      }
      if (name === 'setRawMode' && args[0] === false && process.platform === 'win32') {
        if (pendingRawDisable) clearImmediate(pendingRawDisable);
        // Keep Ink's final readable-loop read raw on Windows.
        pendingRawDisable = setImmediate(() => {
          pendingRawDisable = undefined;
          if (active) applyControl(name, args);
        });
      } else {
        applyControl(name, args);
      }
      return stdin;
    });
  }
  const stdin = new Proxy(source, {
    get(target, key) {
      const control = controls.get(key);
      if (control) return control;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    stdin,
    restore: () => {
      active = false;
      if (pendingRawDisable) clearImmediate(pendingRawDisable);
    },
  };
}

/**
 * Keep the physical TTY in flowing mode while Ink reads from a private stream.
 * This preserves immediate Windows Ctrl+C delivery without bypassing Ink's raw
 * reference count or removing its readable listener. Only the bridge forwards
 * raw/ref operations; the renderer restores the physical stream after unmount.
 */
export function createFlowingStdin(
  source: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): { stdin: NodeJS.ReadStream; restore: () => void } {
  let active = true;
  let requestedRaw = false;
  const input = Object.assign(new PassThrough(), {
    isTTY: source.isTTY,
    isRaw: source.isRaw,
    setRawMode(mode: boolean) {
      if (!active) return input;
      requestedRaw = mode;
      attemptTerminalCleanup(() => source.setRawMode(mode));
      input.isRaw = mode;
      if (mode) attemptTerminalCleanup(() => source.resume());
      return input;
    },
    ref() {
      if (active) attemptTerminalCleanup(() => source.ref());
      return input;
    },
    unref() {
      if (active) attemptTerminalCleanup(() => source.unref());
      return input;
    },
  });
  const onData = (chunk: string | Buffer) => {
    if (active) input.write(chunk);
  };
  const onResize = () => {
    if (!active || !requestedRaw) return;
    // Reassert the physical console state, not Ink's reference count.
    attemptTerminalCleanup(() => source.setRawMode(true));
    attemptTerminalCleanup(() => source.resume());
  };
  const restore = () => {
    if (!active) return;
    active = false;
    attemptTerminalCleanup(() => source.off('data', onData));
    attemptTerminalCleanup(() => stdout.off('resize', onResize));
    attemptTerminalCleanup(() => input.destroy());
  };
  try {
    source.on('data', onData);
    stdout.on('resize', onResize);
  } catch (error) {
    restore();
    throw error;
  }
  // Ink only consumes the readable stream and the TTY methods supplied above.
  return { stdin: input as unknown as NodeJS.ReadStream, restore };
}
