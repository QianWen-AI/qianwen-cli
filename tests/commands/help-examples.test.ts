import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli.js';
import { setReplMode } from '../../src/utils/runtime-mode.js';
import { site } from '../../src/site.js';

// Commander does not expose the `_examples` metadata publicly; we attached it
// via addExamples() in src/cli.ts. Cast locally so the tests stay typed.
type WithExamples = Command & { _examples?: string[] };

function getExamples(program: Command, path: string[]): string[] {
  let cur: Command | undefined = program;
  for (const name of path) {
    cur = cur?.commands.find((c) => c.name() === name);
  }
  return (cur as WithExamples | undefined)?._examples ?? [];
}

// These assertions MUST run before any setReplMode() call in this file.
// runtime-mode keeps a module-scoped flag without a reset API. Vitest isolates
// each test file in its own worker, so the oneshot default is guaranteed here
// as long as we check it first.
describe('help examples — oneshot mode (default)', () => {
  it('prefixes every registered example with the CLI name', () => {
    const program = createProgram();
    const targets: Array<{ path: string[] }> = [
      { path: ['models', 'list'] },
      { path: ['models', 'info'] },
      { path: ['models', 'search'] },
      { path: ['usage', 'summary'] },
      { path: ['usage', 'breakdown'] },
      { path: ['usage', 'free-tier'] },
      { path: ['usage', 'payg'] },
    ];

    for (const { path } of targets) {
      const examples = getExamples(program, path);
      expect(examples.length, `examples missing for ${path.join(' ')}`).toBeGreaterThan(0);
      for (const ex of examples) {
        expect(
          ex.startsWith(`${site.cliName} `),
          `oneshot example "${ex}" should start with "${site.cliName} "`,
        ).toBe(true);
      }
    }
  });
});

describe('help examples — REPL mode', () => {
  it('omits the CLI name prefix so users can copy-paste commands verbatim', () => {
    setReplMode();
    const program = createProgram();

    const targets: Array<{ path: string[] }> = [
      { path: ['models', 'list'] },
      { path: ['models', 'info'] },
      { path: ['models', 'search'] },
      { path: ['usage', 'summary'] },
      { path: ['usage', 'breakdown'] },
      { path: ['usage', 'free-tier'] },
      { path: ['usage', 'payg'] },
    ];

    for (const { path } of targets) {
      const examples = getExamples(program, path);
      expect(examples.length, `examples missing for ${path.join(' ')}`).toBeGreaterThan(0);
      for (const ex of examples) {
        expect(
          ex.startsWith(`${site.cliName} `),
          `REPL example "${ex}" should NOT start with "${site.cliName} "`,
        ).toBe(false);
      }
    }
  });
});
