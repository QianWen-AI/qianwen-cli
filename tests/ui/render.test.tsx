import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { Text, useApp } from 'ink';
import { renderWithInk, renderInteractive } from '../../src/ui/render.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderWithInk', () => {
  it('renders an Ink element to stdout and resolves after paint', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: unknown) => true) as typeof process.stdout.write);

    await renderWithInk(<Text>hello-world-render</Text>);

    // At minimum, the trailing newline should have been written
    expect(writeSpy).toHaveBeenCalled();
    const allChunks = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    // The wrapper writes a trailing '\n' after waitUntilExit
    expect(allChunks).toContain('\n');
  });

  it('resolves even when element renders empty content', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: unknown) => true) as typeof process.stdout.write);

    await renderWithInk(<Text>{''}</Text>);
    expect(writeSpy).toHaveBeenCalled();
  });

  it('exits static rendering only after waitUntil settles', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: unknown) => true) as typeof process.stdout.write);
    let resolveWait: () => void = () => {};
    const waitUntil = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    let finished = false;

    const rendering = renderWithInk(<Text>waiting-render</Text>, { waitUntil }).then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);

    resolveWait();
    await rendering;
    expect(finished).toBe(true);
    expect(writeSpy).toHaveBeenCalled();
  });
});

describe('renderInteractive', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: PropertyDescriptor | undefined;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalTermProgram: string | undefined;

  beforeEach(() => {
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: unknown) => true) as typeof process.stdout.write);
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    // Simulate a non-Windows TTY so the existing alt-screen path is exercised.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    originalTermProgram = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = 'test-runner';
  });

  afterEach(() => {
    if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    else Reflect.deleteProperty(process, 'platform');
    if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = originalTermProgram;
  });

  function AutoExitElement() {
    const app = useApp();
    React.useEffect(() => {
      const h = setImmediate(() => app.exit());
      return () => clearImmediate(h);
    }, [app]);
    return <Text>interactive-content</Text>;
  }

  // Element that snapshots the active resize listeners DURING the alt-screen
  // render phase (inside useEffect) into an external sink, then exits.
  // Capturing the snapshot mid-render is essential: asserting only on the
  // post-exit restored state cannot prove the listeners were isolated
  // WHILE Ink owned the screen.
  function ResizeSnapshotElement({
    sink,
  }: {
    sink: { during: Array<(...args: unknown[]) => void> | null };
  }) {
    const app = useApp();
    React.useEffect(() => {
      sink.during = process.stdout.listeners('resize') as Array<(...args: unknown[]) => void>;
      const h = setImmediate(() => app.exit());
      return () => clearImmediate(h);
    }, [app, sink]);
    return <Text>resize-snapshot-content</Text>;
  }

  it('isolates pre-registered stdout resize listeners during the render', async () => {
    const dummyResize = (): void => {};
    process.stdout.on('resize', dummyResize);

    // Sanity: the dummy listener is present before render.
    expect(process.stdout.listeners('resize')).toContain(dummyResize);

    const sink: { during: Array<(...args: unknown[]) => void> | null } = {
      during: null,
    };

    try {
      await renderInteractive(<ResizeSnapshotElement sink={sink} />);

      // The snapshot must have been taken during the render phase.
      expect(sink.during).not.toBeNull();
      // Core assertion: during the alt-screen render the readline-style
      // resize listener was removed (isolated). Without isolation the dummy
      // would still be present mid-render -> this turns red.
      expect(sink.during).not.toContain(dummyResize);
    } finally {
      process.stdout.removeListener('resize', dummyResize);
    }
  });

  it('restores stdout resize listeners after render completes', async () => {
    const dummyResize = (): void => {};
    process.stdout.on('resize', dummyResize);

    try {
      await renderInteractive(<AutoExitElement />);

      // After renderInteractive finishes, the pre-registered resize listener
      // must be restored so the surrounding readline keeps repainting.
      expect(process.stdout.listeners('resize')).toContain(dummyResize);
    } finally {
      process.stdout.removeListener('resize', dummyResize);
    }
  });

  it('one-shot path with no pre-registered resize listener completes cleanly', async () => {
    // No resize listener is pre-registered (mirrors one-shot mode: no readline).
    // renderInteractive must still complete without throwing and keep the
    // alt-screen enter/exit sequence paired.
    await expect(renderInteractive(<AutoExitElement />)).resolves.toBeUndefined();

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    const enterCount = joined.split('\x1b[?1049h').length - 1;
    const exitCount = joined.split('\x1b[?1049l').length - 1;
    expect(enterCount).toBe(1);
    expect(exitCount).toBe(1);
  });

  it('writes a newline immediately after the alt-screen exit sequence', async () => {
    await renderInteractive(<AutoExitElement />);

    // EXIT_ALT_SCREEN must be immediately followed by '\n' so the shell prompt
    // does not land on the same line as the original command.
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('\x1b[?1049l\n');
  });

  // Element that writes a given chunk through process.stdout.write DURING the
  // alt-screen session, mimicking Ink's resize-race clearTerminal frame. The
  // optional sink captures write()'s return value and whether the callback
  // ran, so frame suppression can be asserted to honour the write() contract.
  function WriteProbeElement({
    payload,
    sink,
  }: {
    payload: string;
    sink?: { returned: boolean | null; cbCalled: boolean };
  }) {
    const app = useApp();
    React.useEffect(() => {
      const returned = process.stdout.write(payload, () => {
        if (sink) sink.cbCalled = true;
      });
      if (sink) sink.returned = returned;
      const h = setImmediate(() => app.exit());
      return () => clearImmediate(h);
    }, [app, payload, sink]);
    return <Text>write-probe</Text>;
  }

  it('suppresses an entire clearTerminal frame containing \\x1b[2J while preserving callbacks', async () => {
    const sink = { returned: null as boolean | null, cbCalled: false };
    await renderInteractive(
      <WriteProbeElement payload={'STALE:\x1b[2J\x1b[3J\x1b[H:FRAME'} sink={sink} />,
    );

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    // Not a single byte of the stale frame reaches stdout — writing it would
    // bypass log-update's accounting and cause the fast-drag artifacts.
    expect(joined).not.toContain('STALE:');
    expect(joined).not.toContain(':FRAME');
    expect(joined).not.toContain('\x1b[2J');
    expect(joined).not.toContain('\x1b[3J');
    // ...while the write() contract is honoured for the suppressed caller.
    expect(sink.returned).toBe(true);
    expect(sink.cbCalled).toBe(true);
  });

  it('strips \\x1b[3J-only chunks during an alt-screen session and writes the remainder', async () => {
    await renderInteractive(<WriteProbeElement payload={'RACE:\x1b[3J\x1b[H:END'} />);

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    // The scrollback-erase sequence never reaches the terminal...
    expect(joined).not.toContain('\x1b[3J');
    // ...while the rest of the chunk passes through intact (no suppression).
    expect(joined).toContain('RACE:\x1b[H:END');
  });

  it('restores write after the session so 2J and 3J pass through unchanged', async () => {
    const beforeWrite = process.stdout.write;
    await renderInteractive(<AutoExitElement />);

    // Identity restored: the session filter did not leak a wrapper.
    expect(process.stdout.write).toBe(beforeWrite);

    // Behaviour restored: a clearTerminal frame written after the session
    // reaches stdout verbatim — neither stripped nor suppressed.
    writeSpy.mockClear();
    process.stdout.write('AFTER:\x1b[2J\x1b[3J\x1b[H:END');
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('AFTER:\x1b[2J\x1b[3J\x1b[H:END');
  });

  it('leaves 2J and 3J unchanged when altScreen is false', async () => {
    await renderInteractive(<WriteProbeElement payload={'RACE:\x1b[2J\x1b[3J\x1b[H:END'} />, {
      altScreen: false,
    });

    // Main-screen sessions (inline editors / ConHost fallback) must keep the
    // stdout stream untouched — clearTerminal repaints are desired there.
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('RACE:\x1b[2J\x1b[3J\x1b[H:END');
  });

  it('suppresses 2J frames but keeps 3J when protectStaticContent is true with altScreen false', async () => {
    const sink = { returned: null as boolean | null, cbCalled: false };
    await renderInteractive(
      <WriteProbeElement payload={'STALE:\x1b[2J\x1b[3J\x1b[H:FRAME'} sink={sink} />,
      { altScreen: false, protectStaticContent: true },
    );

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    // The stale clearTerminal frame is suppressed wholesale because it
    // contains \x1b[2J, protecting main-screen static content.
    expect(joined).not.toContain('STALE:');
    expect(joined).not.toContain(':FRAME');
    expect(joined).not.toContain('\x1b[2J');
    // ...while the write() contract is honoured for the suppressed caller.
    expect(sink.returned).toBe(true);
    expect(sink.cbCalled).toBe(true);
  });

  it('does not strip 3J when protectStaticContent is true with altScreen false', async () => {
    await renderInteractive(<WriteProbeElement payload={'RACE:\x1b[3J\x1b[H:END'} />, {
      altScreen: false,
      protectStaticContent: true,
    });

    // Without the alt-screen, \x1b[3J is NOT stripped from chunks that lack
    // \x1b[2J — the filter only suppresses full clearTerminal frames.
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('\x1b[3J');
    expect(joined).toContain('RACE:\x1b[3J\x1b[H:END');
  });

  it('restores write after protectStaticContent session', async () => {
    const beforeWrite = process.stdout.write;
    await renderInteractive(<AutoExitElement />, {
      altScreen: false,
      protectStaticContent: true,
    });

    // Identity restored: the session filter did not leak a wrapper.
    expect(process.stdout.write).toBe(beforeWrite);
  });

  it('appends a requested newline after inline rendering to prevent horizontal joining', async () => {
    await renderInteractive(<AutoExitElement />, {
      altScreen: false,
      trailingNewline: true,
    });

    const joined = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    // The trailing newline is present but may be followed by an SGR reset
    // (\x1b[0m) emitted during Ink teardown, so check for \n before the end.
    // eslint-disable-next-line no-control-regex
    const stripped = joined.replace(/\x1b\[0m$/, '');
    expect(stripped.endsWith('\n')).toBe(true);
  });
});

// Windows regression: all hosts retain the v1.5 main-screen full-redraw strategy.
describe('renderInteractive in Windows environments', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: PropertyDescriptor | undefined;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalWtSession: string | undefined;
  let originalTermProgram: string | undefined;

  beforeEach(() => {
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: unknown) => true) as typeof process.stdout.write);
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    originalWtSession = process.env.WT_SESSION;
    originalTermProgram = process.env.TERM_PROGRAM;
    delete process.env.WT_SESSION;
    process.env.TERM_PROGRAM = 'qoder';
  });

  afterEach(() => {
    if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    else Reflect.deleteProperty(process, 'platform');
    if (originalWtSession === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = originalWtSession;
    if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = originalTermProgram;
  });

  function AutoExitElement() {
    const app = useApp();
    React.useEffect(() => {
      const h = setImmediate(() => app.exit());
      return () => clearImmediate(h);
    }, [app]);
    return <Text>conhost-content</Text>;
  }

  function WriteProbeElement({ payload }: { payload: string }) {
    const app = useApp();
    React.useEffect(() => {
      process.stdout.write(payload);
      const h = setImmediate(() => app.exit());
      return () => clearImmediate(h);
    }, [app, payload]);
    return <Text>conhost-write-probe</Text>;
  }

  it('uses the main screen on Qoder for Windows and clears it on exit', async () => {
    await renderInteractive(<AutoExitElement />);

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).not.toContain('\x1b[?1049h');
    expect(joined).not.toContain('\x1b[?1049l');
    expect(joined).toContain('\x1b[2J\x1b[H');
  });

  it('does not intercept Ink 2J/3J full-redraw frames on the Windows main screen', async () => {
    await renderInteractive(<WriteProbeElement payload={'RACE:\x1b[3J\x1b[H:END'} />);

    let joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('RACE:\x1b[3J\x1b[H:END');

    writeSpy.mockClear();

    await renderInteractive(<WriteProbeElement payload={'STALE:\x1b[2J\x1b[H:FRAME'} />);

    joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('STALE:\x1b[2J\x1b[H:FRAME');
    expect(joined).toContain('\x1b[2J\x1b[H');
  });
});
