/**
 * Tests for AgentDirPrompt — scope recommendation, ←/→ scope toggle,
 * Hermes disabled under project scope, mismatch warning (non-blocking),
 * install-location preview and the onSelect contract. Keyboard input is
 * driven through the ink stdin patch pattern (RechargePaymentWait precedent)
 * because ink-testing-library's stdin stub cannot host useInput on its own.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import chalk from 'chalk';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { getKnownAgents } from '../../src/utils/agent-dirs.js';

const HOME = '/home/agent-ui-tester';
const PROJECT_CWD = '/workspace/project-x';
const HOME_CWD = path.join(HOME, 'proj');
const SLUG = '@qianwen-ai/pdf-extractor';

const RIGHT = '\u001b[C';
const LEFT = '\u001b[D';
const DOWN = '\u001b[B';
const ENTER = '\r';
const ESC = '\u001b';

const { exitSpy, homedirMock } = vi.hoisted(() => ({
  exitSpy: vi.fn(),
  homedirMock: vi.fn<() => string>(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: homedirMock },
    homedir: homedirMock,
  };
});

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useApp: () => ({ exit: exitSpy }),
    useStdin: () => {
      const real = actual.useStdin();
      return { ...real, isRawModeSupported: true };
    },
  };
});

const { AgentDirPrompt } = await import('../../src/ui/AgentDirPrompt.js');

type PromptInstance = ReturnType<typeof render>;

interface PromptHandle {
  instance: PromptInstance;
  onSelect: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Patch the testing-library stdin into ink 5.2.1's input protocol: App
 * subscribes to 'readable' and pulls chunks via stdin.read(), then forwards
 * them to useInput through an internal emitter. The stub Stdin only emits
 * 'data' (and lacks ref/unref/read), so write() is bridged into that
 * pull-based protocol synchronously, before passive effects flush.
 */
function renderPrompt(cwd: string, defaultPath: string = cwd): PromptHandle {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  cwdSpy.mockReturnValue(cwd);
  const instance = render(
    <AgentDirPrompt
      defaultPath={defaultPath}
      agents={getKnownAgents()}
      slug={SLUG}
      onSelect={onSelect}
      onCancel={onCancel}
    />,
  );
  const stdin = instance.stdin as unknown as Record<string, unknown> & NodeJS.EventEmitter;
  if (typeof stdin.ref !== 'function') stdin.ref = () => {};
  if (typeof stdin.unref !== 'function') stdin.unref = () => {};
  stdin.setRawMode = vi.fn();
  if (typeof stdin.resume !== 'function') stdin.resume = vi.fn();
  const pending: string[] = [];
  stdin.read = () => pending.shift() ?? null;
  stdin.write = (data: string) => {
    pending.push(data);
    stdin.emit('readable');
    return true;
  };
  return { instance, onSelect, onCancel };
}

async function press(instance: PromptInstance, key: string): Promise<void> {
  instance.stdin.write(key);
  await flushEffects();
}

async function renderAgentList(cwd: string): Promise<PromptHandle> {
  const handle = renderPrompt(cwd);
  await flushEffects();
  await press(handle.instance, RIGHT);
  await press(handle.instance, ENTER);
  return handle;
}

async function pressDown(instance: PromptInstance, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await press(instance, DOWN);
  }
}

const ESC_CHAR = String.fromCharCode(27);
const SGR_RUN = new RegExp(`${ESC_CHAR}\\[[0-9;]*m`, 'g');

/** ANSI wrap (open run | close run) around a label inside a single raw line. */
function labelWrap(line: string, label: string): string {
  const idx = line.indexOf(label);
  expect(idx).toBeGreaterThanOrEqual(0);
  const opens = line.slice(0, idx).match(SGR_RUN) ?? [];
  const closes = line.slice(idx + label.length).match(SGR_RUN) ?? [];
  return `${opens[opens.length - 1] ?? ''}|${closes[0] ?? ''}`;
}

function rawLine(instance: PromptInstance, needle: string): string {
  const line = (instance.lastFrame() ?? '').split('\n').find((l) => stripAnsi(l).includes(needle));
  expect(line).toBeDefined();
  return line!;
}

function plainLine(instance: PromptInstance, needle: string): string {
  return stripAnsi(rawLine(instance, needle));
}

let cwdSpy: ReturnType<typeof vi.spyOn>;
let chalkLevel: number;

beforeEach(() => {
  chalkLevel = chalk.level;
  chalk.level = 3;
  exitSpy.mockReset();
  homedirMock.mockReturnValue(HOME);
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(PROJECT_CWD);
});

afterEach(() => {
  chalk.level = chalkLevel;
  cwdSpy.mockRestore();
  homedirMock.mockReset();
});

describe('AgentDirPrompt — default scope recommendation', () => {
  it('defaults to project scope when cwd is outside the home directory', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    expect(plainLine(instance, 'Install location')).not.toContain('is recommended');
    const scopeLine = plainLine(instance, 'Scope:');
    expect(scopeLine).toContain('Project');
    expect(scopeLine).not.toContain('Global');
    instance.unmount();
  });

  it('defaults to project scope when cwd is a subdirectory under home', async () => {
    const { instance } = await renderAgentList(HOME_CWD);
    expect(plainLine(instance, 'Install location')).not.toContain('is recommended');
    const scopeLine = plainLine(instance, 'Scope:');
    expect(scopeLine).toContain('Project');
    expect(scopeLine).not.toContain('Global');
    instance.unmount();
  });

  it('treats cwd === homedir itself as global', async () => {
    const { instance } = await renderAgentList(HOME);
    expect(plainLine(instance, 'Install location')).not.toContain('is recommended');
    const scopeLine = plainLine(instance, 'Scope:');
    expect(scopeLine).toContain('Global');
    expect(scopeLine).not.toContain('Project');
    instance.unmount();
  });

  it('bases the recommendation on process.cwd(), not the install target path', async () => {
    // defaultPath is home itself (would recommend global) while the user's
    // cwd sits outside home — the recommendation must follow the cwd.
    const handle = renderPrompt(PROJECT_CWD, HOME);
    await flushEffects();
    await press(handle.instance, RIGHT);
    await press(handle.instance, ENTER);
    const scopeLine = plainLine(handle.instance, 'Scope:');
    expect(scopeLine).toContain('Project');
    expect(scopeLine).not.toContain('Global');
    handle.instance.unmount();
  });
});

describe('AgentDirPrompt — scope toggle via arrow keys', () => {
  it('right arrow toggles project → global and switches the directory column', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    await press(instance, RIGHT);
    expect(plainLine(instance, 'Codex')).toContain(path.join(HOME, '.codex', 'skills'));
    instance.unmount();
  });

  it('scope row shows only the active scope after toggling', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    await press(instance, RIGHT);
    const scopeLine = plainLine(instance, 'Scope:');
    expect(scopeLine).toContain('Global');
    expect(scopeLine).not.toContain('Project');
    instance.unmount();
  });

  it('left arrow toggles global → project', async () => {
    const { instance } = await renderAgentList(HOME);
    await press(instance, LEFT);
    expect(plainLine(instance, 'Codex')).toContain(path.resolve(HOME, '.agents/skills'));
    instance.unmount();
  });

  it('both arrow keys toggle between the two scopes (second press returns to origin)', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    await press(instance, RIGHT);
    await press(instance, RIGHT);
    expect(plainLine(instance, 'Codex')).toContain(path.resolve(PROJECT_CWD, '.agents/skills'));
    instance.unmount();
  });

  it('project scope lists project-level dirs for representative agents', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    expect(plainLine(instance, 'Claude Code')).toContain(
      path.resolve(PROJECT_CWD, '.claude/skills'),
    );
    expect(plainLine(instance, 'OpenCode')).toContain(
      path.resolve(PROJECT_CWD, '.opencode/skills'),
    );
    instance.unmount();
  });

  it('global scope lists home-based dirs for representative agents', async () => {
    const { instance } = await renderAgentList(HOME);
    expect(plainLine(instance, 'Claude Code')).toContain(path.join(HOME, '.claude', 'skills'));
    expect(plainLine(instance, 'OpenCode')).toContain(
      path.join(HOME, '.config', 'opencode', 'skills'),
    );
    instance.unmount();
  });
});

describe('AgentDirPrompt — Hermes disabled under project scope', () => {
  it('renders the Hermes row visually distinct (disabled) under project scope', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    await pressDown(instance, 14);
    const hermesLine = rawLine(instance, 'Hermes');
    expect(hermesLine).not.toContain(PROJECT_CWD);
    const openclawLine = rawLine(instance, 'OpenClaw');
    expect(labelWrap(hermesLine, 'Hermes')).not.toBe(labelWrap(openclawLine, 'OpenClaw'));
    instance.unmount();
  });

  it('never confirms a Hermes selection under project scope', async () => {
    const { instance, onSelect } = await renderAgentList(PROJECT_CWD);
    await pressDown(instance, 14);
    await press(instance, ENTER);
    instance.unmount();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const selection = onSelect.mock.calls[0][0];
    expect(selection.scope).toBe('project');
    expect(selection.agent?.name).not.toBe('hermes');
    expect(selection.agent?.name).toBe('kimi-code');
  });

  it('keeps Hermes selectable under global scope', async () => {
    const { instance, onSelect } = await renderAgentList(HOME);
    await pressDown(instance, 14);
    expect(plainLine(instance, 'Hermes')).toContain(path.join(HOME, '.hermes', 'skills'));
    await press(instance, ENTER);
    instance.unmount();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      scope: 'global',
      path: path.join(HOME, '.hermes', 'skills'),
      agent: { name: 'hermes' },
    });
  });
});

describe('AgentDirPrompt — scope mismatch warning', () => {
  it('shows the red warning when global is selected on a project path', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    await press(instance, RIGHT);
    expect(plainLine(instance, 'is recommended').trim()).toBe(
      '\u26A0 Project is recommended for the current location. Global is selected.',
    );
    const warnLine = rawLine(instance, 'is recommended');
    expect(warnLine).toContain(`${ESC_CHAR}[31m`);
    expect(warnLine).not.toContain(`${ESC_CHAR}[38;2;`);
    instance.unmount();
  });

  it('shows the red warning when project is selected on a global path', async () => {
    const { instance } = await renderAgentList(HOME);
    await press(instance, LEFT);
    expect(plainLine(instance, 'is recommended').trim()).toBe(
      '\u26A0 Global is recommended for the current location. Project is selected.',
    );
    const warnLine = rawLine(instance, 'is recommended');
    expect(warnLine).toContain(`${ESC_CHAR}[31m`);
    instance.unmount();
  });

  it('hides the warning after switching back to the recommended scope', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    await press(instance, RIGHT);
    expect(plainLine(instance, 'is recommended')).toContain('Global is selected.');
    await press(instance, LEFT);
    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).not.toContain('is recommended for the current location');
    instance.unmount();
  });

  it('shows no warning while on the recommended scope', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain(
      'is recommended for the current location',
    );
    instance.unmount();
  });
});

describe('AgentDirPrompt — install location preview', () => {
  it('shows the full slug path for the selected agent under project scope', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('Install location');
    expect(frame).toContain(
      path.join(path.resolve(PROJECT_CWD, '.claude/skills'), 'pdf-extractor'),
    );
    instance.unmount();
  });

  it('updates the install location prefix when the scope toggles', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    await press(instance, RIGHT);
    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain(path.join(path.join(HOME, '.claude/skills'), 'pdf-extractor'));
    instance.unmount();
  });

  it('updates the install location when the agent selection moves', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    await press(instance, DOWN);
    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain(
      path.join(path.resolve(PROJECT_CWD, '.agents/skills'), 'pdf-extractor'),
    );
    instance.unmount();
  });
});

describe('AgentDirPrompt — footer shortcut hints', () => {
  it('renders the shortcut hint line including the scope toggle', async () => {
    const { instance } = await renderAgentList(PROJECT_CWD);
    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('\u2191/\u2193 Agent');
    expect(frame).toContain('\u2190/\u2192 Scope');
    expect(frame).toContain('Enter Confirm');
    expect(frame).toContain('Esc Back');
    instance.unmount();
  });
});

describe('AgentDirPrompt — onSelect contract', () => {
  it('returns the selection carrying scope on Enter', async () => {
    const { instance, onSelect } = await renderAgentList(HOME);
    await press(instance, ENTER);
    instance.unmount();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      scope: 'global',
      path: path.join(HOME, '.claude', 'skills'),
    });
  });

  it('confirms with a mismatch warning visible (warning does not block Enter)', async () => {
    const { instance, onSelect } = await renderAgentList(PROJECT_CWD);
    await press(instance, RIGHT);
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain(
      'is recommended for the current location',
    );
    await press(instance, ENTER);
    instance.unmount();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ scope: 'global' });
  });

  it('cancel path yields null without a selection', async () => {
    const { instance, onSelect, onCancel } = await renderAgentList(PROJECT_CWD);
    await press(instance, ESC);
    await press(instance, ESC);
    instance.unmount();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
