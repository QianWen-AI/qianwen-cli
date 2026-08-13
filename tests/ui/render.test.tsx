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
      .mockImplementation(((_chunk: any) => true) as any);

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
      .mockImplementation(((_chunk: any) => true) as any);

    await renderWithInk(<Text>{''}</Text>);
    expect(writeSpy).toHaveBeenCalled();
  });
});

describe('renderInteractive', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: any) => true) as any);
    originalIsTTY = process.stdout.isTTY;
    // Simulate TTY so alt-screen code path is exercised
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
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

  it('alt-screen 退出序列后立即补换行，使提示符落在新行', async () => {
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

  it('alt-screen 会话期间含 \\x1b[2J 的 clearTerminal 帧被整帧抑制，回调仍被调用', async () => {
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

  it('alt-screen 会话期间仅含 \\x1b[3J（无 2J）的 chunk 剥离 3J 后照常写出', async () => {
    await renderInteractive(<WriteProbeElement payload={'RACE:\x1b[3J\x1b[H:END'} />);

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    // The scrollback-erase sequence never reaches the terminal...
    expect(joined).not.toContain('\x1b[3J');
    // ...while the rest of the chunk passes through intact (no suppression).
    expect(joined).toContain('RACE:\x1b[H:END');
  });

  it('会话结束后 write 恢复原样，2J/3J 均原样通过', async () => {
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

  it('非 alt-screen 会话（altScreen: false）不安装过滤器，2J/3J 原样写出', async () => {
    await renderInteractive(<WriteProbeElement payload={'RACE:\x1b[2J\x1b[3J\x1b[H:END'} />, {
      altScreen: false,
    });

    // Main-screen sessions (inline editors / ConHost fallback) must keep the
    // stdout stream untouched — clearTerminal repaints are desired there.
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('RACE:\x1b[2J\x1b[3J\x1b[H:END');
  });
});
