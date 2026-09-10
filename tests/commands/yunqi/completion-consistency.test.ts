/**
 * Completion consistency for `yunqi list`.
 *
 * Four surfaces hand-list the yunqi flags: the command's own RESOURCE_FLAGS
 * validator, the REPL completer, and the bash/zsh/fish generators. If they
 * disagree, completion offers a flag the command then rejects. These tests
 * derive the expectation from RESOURCE_FLAGS — the same source of truth the
 * runtime validator uses — and parse the generated scripts, so drift in any
 * surface fails here.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerCompletionCommand } from '../../../src/commands/completion.js';
import { RESOURCES, RESOURCE_FLAGS } from '../../../src/commands/yunqi/list-forums.js';
import type { Resource } from '../../../src/commands/yunqi/list-forums.js';
import { COMMAND_FLAGS } from '../../../src/repl/completer.js';
import { runCommand } from '../../helpers/run-command.js';

async function generateScript(shell: string): Promise<string> {
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await runCommand(
      (program) => registerCompletionCommand(program),
      ['completion', 'generate', '--shell', shell],
    );
    return writeSpy.mock.calls.map((c) => String(c[0])).join('');
  } finally {
    writeSpy.mockRestore();
  }
}

function kebab(optionKey: string): string {
  return `--${optionKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** What the command actually accepts for a resource, plus the universal flags. */
function acceptedFlags(resource: Resource): Set<string> {
  const flags = new Set<string>(['--format', '-h', '--help']);
  for (const key of RESOURCE_FLAGS[resource]) flags.add(kebab(key));
  return flags;
}

/** Every yunqi list flag that exists on the command but not for this resource. */
function rejectedFlags(resource: Resource): Set<string> {
  const accepted = acceptedFlags(resource);
  const all = new Set<string>();
  for (const r of RESOURCES) for (const f of acceptedFlags(r)) all.add(f);
  return new Set([...all].filter((f) => !accepted.has(f)));
}

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

// ── bash ─────────────────────────────────────────────────────────────────────

function bashFlagsFor(script: string, resource: string): Set<string> {
  // Anchored on the branch head so the `*)` fallback, which lists the resource
  // names inside its own compgen word list, cannot match.
  const match = new RegExp(`^\\s*${resource}\\)\\s+COMPREPLY=.*compgen -W "([^"]*)"`, 'm').exec(
    script,
  );
  expect(match, `bash: no ${resource} branch found`).not.toBeNull();
  return new Set((match as RegExpExecArray)[1].split(/\s+/).filter(Boolean));
}

// ── zsh ──────────────────────────────────────────────────────────────────────

function zshFlagsFor(script: string, resource: string): Set<string> {
  const match = new RegExp(`^\\s+${resource}\\)\\s*\\n([\\s\\S]*?)^\\s+;;`, 'm').exec(script);
  expect(match, `zsh: no ${resource} block found`).not.toBeNull();
  const block = (match as RegExpExecArray)[1];
  const flags = new Set<string>();
  for (const m of block.matchAll(/'(--[a-z-]+)\[/g)) flags.add(m[1]);
  if (block.includes('{-h,--help}')) {
    flags.add('-h');
    flags.add('--help');
  }
  return flags;
}

// ── fish ─────────────────────────────────────────────────────────────────────

/**
 * Positive `__fish_seen_subcommand_from` groups in a condition. Clauses joined
 * by `; and` that start with `not` are negative and excluded — `not
 * __fish_seen_subcommand_from forums` must not count as matching forums.
 */
function fishPositiveGroups(condition: string): string[][] {
  return condition
    .split('; and')
    .map((clause) => clause.trim())
    .filter((clause) => clause.startsWith('__fish_seen_subcommand_from'))
    .map((clause) =>
      clause.replace('__fish_seen_subcommand_from', '').trim().split(/\s+/).filter(Boolean),
    );
}

function fishOffers(script: string, resource: string, flag: string): boolean {
  for (const line of script.split('\n')) {
    if (!line.startsWith('complete ')) continue;
    if (!line.includes(`-l ${flag.slice(2)} `) && !line.endsWith(`-l ${flag.slice(2)}`)) continue;
    const condition = /-n '([^']*)'/.exec(line)?.[1];
    // No -n means the completion is unconditional (--format, --help and
    // --version are registered globally), so it applies to every resource.
    if (condition === undefined) return true;
    if (fishPositiveGroups(condition).some((group) => group.includes(resource))) return true;
  }
  return false;
}

describe('yunqi list 补全与运行时校验一致', () => {
  it.each([...RESOURCES])('bash: %s 分支提供的 flag 与命令接受的完全相同', async (resource) => {
    const script = await generateScript('bash');
    expect(sorted(bashFlagsFor(script, resource))).toEqual(sorted(acceptedFlags(resource)));
  });

  it.each([...RESOURCES])('zsh: %s 分支提供的 flag 与命令接受的完全相同', async (resource) => {
    const script = await generateScript('zsh');
    expect(sorted(zshFlagsFor(script, resource))).toEqual(sorted(acceptedFlags(resource)));
  });

  it.each([...RESOURCES])('fish: %s 下不提供任何会被拒绝的 flag', async (resource) => {
    const script = await generateScript('fish');
    for (const flag of rejectedFlags(resource)) {
      expect(fishOffers(script, resource, flag), `fish offers ${flag} for ${resource}`).toBe(false);
    }
  });

  it.each([...RESOURCES])('fish: %s 下提供全部被接受的长 flag', async (resource) => {
    const script = await generateScript('fish');
    for (const flag of acceptedFlags(resource)) {
      if (flag === '-h') continue;
      expect(fishOffers(script, resource, flag), `fish missing ${flag} for ${resource}`).toBe(true);
    }
  });

  it.each([...RESOURCES])('REPL: %s 的 COMMAND_FLAGS 与命令接受的一致', (resource) => {
    const replFlags = COMMAND_FLAGS[`yunqi list ${resource}`];
    expect(replFlags, `REPL has no entry for yunqi list ${resource}`).toBeDefined();
    // HELP_FLAG is injected separately by the completer, so compare without it.
    const accepted = [...acceptedFlags(resource)].filter((f) => f !== '-h' && f !== '--help');
    expect(sorted(new Set(replFlags))).toEqual(sorted(new Set(accepted)));
  });
});

describe('yunqi 补全的既有缺陷回归', () => {
  it('fish 不再用 OR 语义的 "yunqi list" 条件（会在 models list 后误提示）', async () => {
    const script = await generateScript('fish');
    expect(script).not.toContain("__fish_seen_subcommand_from yunqi list'");
    expect(script).not.toContain('__fish_seen_subcommand_from yunqi subscribe unsubscribe');
  });

  it('bash 为 subscribe/unsubscribe 提供 forum 位置参数', async () => {
    const script = await generateScript('bash');
    const block = /subscribe\|unsubscribe\)\s*\n([\s\S]*?)esac ;;/.exec(script);
    expect(block, 'bash: no subscribe branch').not.toBeNull();
    expect((block as RegExpExecArray)[1]).toContain('forum');
  });

  it('zsh 与 fish 也为 subscribe/unsubscribe 提供 forum', async () => {
    const zsh = await generateScript('zsh');
    expect(zsh).toContain("'1:resource:(forum)'");
    const fish = await generateScript('fish');
    expect(fish).toMatch(/-a forum -d/);
  });

  it('三套脚本都非空且含 yunqi 段（防止模板字符串被截断）', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const script = await generateScript(shell);
      expect(script.length, `${shell} script is suspiciously short`).toBeGreaterThan(2000);
      expect(script, `${shell} script has no yunqi section`).toContain('yunqi');
    }
  });
});
