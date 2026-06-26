/**
 * Unit tests for the `multilineInput` raw-mode reader's stdin lifecycle guard.
 *
 * Contract (BUG-7): renderInteractive already pauses + unrefs stdin so a
 * one-shot process can exit naturally once interaction completes. multilineInput
 * must therefore only RE-REF stdin (resume + ref) when running inside a REPL
 * (isReplMode() === true). In one-shot mode it must leave stdin released so the
 * event loop is not held open and the process exits on its own.
 *
 * Mock boundary:
 *   • renderInteractive — external UI/IO dependency. Mocked to resolve the
 *     editor with a submitted value (drives the SUT's onSubmit seam).
 *   • isReplMode — external runtime-mode dependency. Toggled per test.
 *   • process.stdin.ref / resume / pause / unref — the IO boundary the guard
 *     acts on. Spied to observe whether the SUT re-refs.
 * The SUT's own logic (the isReplMode-gated release/keep decision) is NOT
 * mocked — it is exactly what these tests exercise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type React from 'react';

const renderHolder: { submit: string } = { submit: 'typed reply' };
const replHolder: { repl: boolean } = { repl: false };

vi.mock('../../src/ui/render.js', () => ({
  renderInteractive: vi.fn(async (element: React.ReactElement) => {
    const props = (element as unknown as { props: Record<string, unknown> }).props;
    if (typeof props.onSubmit === 'function') {
      (props.onSubmit as (text: string) => void)(renderHolder.submit);
    }
  }),
  renderWithInk: vi.fn(),
  renderWithInkSync: vi.fn(),
}));

vi.mock('../../src/utils/runtime-mode.js', () => ({
  isReplMode: () => replHolder.repl,
}));

const { multilineInput } = await import('../../src/utils/multiline-input.js');

// ── stdin spy harness ──────────────────────────────────────────────────────

interface StdinSpies {
  ref: ReturnType<typeof vi.spyOn>;
  unref: ReturnType<typeof vi.spyOn>;
  resume: ReturnType<typeof vi.spyOn>;
  pause: ReturnType<typeof vi.spyOn>;
}

let spies: StdinSpies;

function ensureMethod(name: 'ref' | 'unref' | 'resume' | 'pause'): void {
  const stdin = process.stdin as unknown as Record<string, unknown>;
  if (typeof stdin[name] !== 'function') {
    stdin[name] = () => process.stdin;
  }
}

beforeEach(() => {
  renderHolder.submit = 'typed reply';
  replHolder.repl = false;
  (['ref', 'unref', 'resume', 'pause'] as const).forEach(ensureMethod);
  spies = {
    ref: vi.spyOn(process.stdin, 'ref' as never).mockImplementation((() => process.stdin) as never),
    unref: vi
      .spyOn(process.stdin, 'unref' as never)
      .mockImplementation((() => process.stdin) as never),
    resume: vi
      .spyOn(process.stdin, 'resume' as never)
      .mockImplementation((() => process.stdin) as never),
    pause: vi
      .spyOn(process.stdin, 'pause' as never)
      .mockImplementation((() => process.stdin) as never),
  };
});

afterEach(() => {
  spies.ref.mockRestore();
  spies.unref.mockRestore();
  spies.resume.mockRestore();
  spies.pause.mockRestore();
  vi.clearAllMocks();
});

describe('multilineInput — stdin release guard (BUG-7)', () => {
  it('resolves with the submitted text from the editor', async () => {
    renderHolder.submit = 'hello world';
    const result = await multilineInput({ title: 'Reply' });
    expect(result).toBe('hello world');
  });

  it('does NOT re-ref stdin in one-shot mode (process can exit naturally)', async () => {
    replHolder.repl = false;

    await multilineInput({ title: 'Reply' });

    // Counter-factual regression guard: if the implementation unconditionally
    // re-refs stdin after renderInteractive, this assertion turns red and the
    // one-shot hang reappears.
    expect(spies.ref).not.toHaveBeenCalled();
  });

  it('re-refs stdin in REPL mode (keeps the handle alive for the prompt)', async () => {
    replHolder.repl = true;

    await multilineInput({ title: 'Reply' });

    expect(spies.ref).toHaveBeenCalled();
  });
});
