/**
 * Tests for the skills pack-install view-model — title tri-state, scope- and
 * mode-dependent statusLabel, per-item row mapping (B2: row-level co-occurrence
 * assertions, no double-space locking), summary counting and the Mode/Location
 * label pair (B10).
 */
import { describe, it, expect } from 'vitest';
import { buildPackInstallViewModel } from '../../../src/view-models/skills/index.js';
import type { PackInstallResult } from '../../../src/types/skills.js';

const EM_DASH = '\u2014';

function packResultOf(overrides: Partial<PackInstallResult> = {}): PackInstallResult {
  return {
    pack: 'qianwen-pack',
    displayName: 'Qianwen Official Pack',
    overallStatus: 'partial',
    baseDir: '/tmp/skills',
    summary: { installed: 1, changed: 1, skipped: 1, failed: 1 },
    items: [
      {
        fullSlug: '@qianwen-ai/skill-a',
        outcome: 'installed',
        version: '1.2.0',
        targetDir: '/tmp/skills/@qianwen-ai/skill-a',
      },
      {
        fullSlug: '@qianwen-ai/skill-b',
        outcome: 'changed',
        version: '1.2.0',
        previousVersion: '1.1.0',
        targetDir: '/tmp/skills/@qianwen-ai/skill-b',
      },
      {
        fullSlug: '@other-ns/skill-c',
        outcome: 'noop',
        version: '0.9.0',
      },
      {
        fullSlug: '@qianwen-ai/skill-d',
        outcome: 'failed',
        error: {
          code: 'DOWNLOAD_FAILED',
          message: 'Skill package download failed. Check your network and try again.',
        },
      },
    ],
    ...overrides,
  };
}

describe('buildPackInstallViewModel — title tri-state', () => {
  it('success (not all noop) → ✓ Skill pack installed successfully', () => {
    const vm = buildPackInstallViewModel(
      packResultOf({
        overallStatus: 'success',
        summary: { installed: 1, changed: 1, skipped: 1, failed: 0 },
      }),
      { mode: 'agent', agentDisplayName: 'Codex', scope: 'project' },
    );
    expect(vm.titleIcon).toBe('\u2713');
    expect(vm.titleText).toBe('Skill pack installed successfully');
    expect(vm.isAllNoop).toBe(false);
  });

  it('success (all noop) → ✓ Skill pack already installed — nothing to do', () => {
    const vm = buildPackInstallViewModel(
      packResultOf({
        overallStatus: 'success',
        summary: { installed: 0, changed: 0, skipped: 2, failed: 0 },
        items: [
          { fullSlug: '@qianwen-ai/skill-a', outcome: 'noop', version: '1.2.0' },
          { fullSlug: '@other-ns/skill-c', outcome: 'noop', version: '0.9.0' },
        ],
      }),
      { mode: 'agent', agentDisplayName: 'Codex', scope: 'project' },
    );
    expect(vm.titleIcon).toBe('\u2713');
    expect(vm.titleText).toBe(`Skill pack already installed ${EM_DASH} nothing to do`);
    expect(vm.isAllNoop).toBe(true);
  });

  it('partial (with actual installs) → ⚠ Skill pack installed with some failures', () => {
    const vm = buildPackInstallViewModel(packResultOf(), {
      mode: 'agent',
      agentDisplayName: 'Codex',
      scope: 'project',
    });
    expect(vm.titleIcon).toBe('\u26a0');
    expect(vm.titleText).toBe('Skill pack installed with some failures');
  });

  it('partial (no actual installs, noop + failed) shows no-install title', () => {
    const vm = buildPackInstallViewModel(
      packResultOf({
        overallStatus: 'partial',
        summary: { installed: 0, changed: 0, skipped: 1, failed: 1 },
        items: [
          { fullSlug: '@qianwen-ai/skill-a', outcome: 'noop', version: '1.2.0' },
          {
            fullSlug: '@qianwen-ai/skill-d',
            outcome: 'failed',
            error: { code: 'UNMANAGED_CONFLICT', message: 'conflict' },
          },
        ],
      }),
      { mode: 'agent', agentDisplayName: 'Codex', scope: 'project' },
    );
    expect(vm.titleIcon).toBe('\u26a0');
    expect(vm.titleText).toBe('No skills were installed');
    expect(vm.titleText).not.toContain('installed with');
  });

  it('failed → ✗ Skill pack installation failed', () => {
    const vm = buildPackInstallViewModel(
      packResultOf({
        overallStatus: 'failed',
        summary: { installed: 0, changed: 0, skipped: 0, failed: 2 },
        items: [
          {
            fullSlug: '@qianwen-ai/skill-a',
            outcome: 'failed',
            error: { code: 'INSTALL_FAILED', message: 'boom' },
          },
          {
            fullSlug: '@qianwen-ai/skill-d',
            outcome: 'failed',
            error: { code: 'DOWNLOAD_FAILED', message: 'offline' },
          },
        ],
      }),
      { mode: 'agent', agentDisplayName: 'Codex', scope: 'project' },
    );
    expect(vm.titleIcon).toBe('\u2717');
    expect(vm.titleText).toBe('Skill pack installation failed');
  });
});

describe('buildPackInstallViewModel — statusLabel', () => {
  const successResult = packResultOf({
    overallStatus: 'success',
    summary: { installed: 2, changed: 0, skipped: 0, failed: 0 },
  });

  it('success + project scope → Ready to use in this project', () => {
    const vm = buildPackInstallViewModel(successResult, {
      mode: 'agent',
      agentDisplayName: 'Codex',
      scope: 'project',
    });
    expect(vm.statusLabel).toBe('Ready to use in this project');
  });

  it('success + global scope → Ready to use globally', () => {
    const vm = buildPackInstallViewModel(successResult, {
      mode: 'agent',
      agentDisplayName: 'Codex',
      scope: 'global',
    });
    expect(vm.statusLabel).toBe('Ready to use globally');
  });

  it('agent mode without scope keeps the project wording (backward compatible)', () => {
    const vm = buildPackInstallViewModel(successResult, {
      mode: 'agent',
      agentDisplayName: 'Codex',
    });
    expect(vm.statusLabel).toBe('Ready to use in this project');
  });

  it('partial (with actual installs) → Completed with failures regardless of mode', () => {
    const vm = buildPackInstallViewModel(packResultOf(), {
      mode: 'agent',
      agentDisplayName: 'Codex',
      scope: 'project',
    });
    expect(vm.statusLabel).toBe('Completed with failures');
  });

  it('partial (no actual installs) → No skills were installed', () => {
    const vm = buildPackInstallViewModel(
      packResultOf({
        overallStatus: 'partial',
        summary: { installed: 0, changed: 0, skipped: 1, failed: 1 },
        items: [
          { fullSlug: '@qianwen-ai/skill-a', outcome: 'noop', version: '1.2.0' },
          {
            fullSlug: '@qianwen-ai/skill-d',
            outcome: 'failed',
            error: { code: 'UNMANAGED_CONFLICT', message: 'conflict' },
          },
        ],
      }),
      { mode: 'agent', agentDisplayName: 'Codex', scope: 'project' },
    );
    expect(vm.statusLabel).toBe('No skills were installed');
  });

  it('failed → No skills were installed regardless of mode', () => {
    const vm = buildPackInstallViewModel(
      packResultOf({
        overallStatus: 'failed',
        summary: { installed: 0, changed: 0, skipped: 0, failed: 1 },
        items: [
          {
            fullSlug: '@qianwen-ai/skill-a',
            outcome: 'failed',
            error: { code: 'INSTALL_FAILED', message: 'x' },
          },
        ],
      }),
      { mode: 'agent', agentDisplayName: 'Codex', scope: 'project' },
    );
    expect(vm.statusLabel).toBe('No skills were installed');
  });

  it('current-dir mode → Installed (T-10, aligned with the single-skill wording)', () => {
    const vm = buildPackInstallViewModel(successResult, { mode: 'current-dir' });
    expect(vm.statusLabel).toBe('Installed');
  });

  it('explicit-dir mode → Installed (T-10)', () => {
    const vm = buildPackInstallViewModel(successResult, { mode: 'explicit-dir' });
    expect(vm.statusLabel).toBe('Installed');
  });
});

describe('buildPackInstallViewModel — Mode/Location label pair (B10)', () => {
  it('agent mode → Agent / agent display name / Base directory', () => {
    const vm = buildPackInstallViewModel(packResultOf(), {
      mode: 'agent',
      agentDisplayName: 'Codex',
      scope: 'project',
    });
    expect(vm.modeLabel).toBe('Agent');
    expect(vm.modeValue).toBe('Codex');
    expect(vm.baseDirLabel).toBe('Base directory');
    expect(vm.baseDir).toBe('/tmp/skills');
  });

  it('agent mode without a display name falls back to an em dash', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'agent' });
    expect(vm.modeValue).toBe(EM_DASH);
  });

  it('current-dir mode → Mode / Current directory / Location', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });
    expect(vm.modeLabel).toBe('Mode');
    expect(vm.modeValue).toBe('Current directory');
    expect(vm.baseDirLabel).toBe('Location');
  });

  it('explicit-dir mode → Mode / Explicit directory (--dir) / Location', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'explicit-dir' });
    expect(vm.modeLabel).toBe('Mode');
    expect(vm.modeValue).toBe('Explicit directory (--dir)');
    expect(vm.baseDirLabel).toBe('Location');
  });
});

describe('buildPackInstallViewModel — per-item rows', () => {
  it('installed → ✓ with a v-prefixed version label', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });
    expect(vm.items[0]).toEqual({
      icon: '\u2713',
      fullSlug: '@qianwen-ai/skill-a',
      outcomeLabel: 'installed',
      versionLabel: 'v1.2.0',
    });
  });

  it('changed → ~ with a previous → target version label', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });
    expect(vm.items[1]).toEqual({
      icon: '~',
      fullSlug: '@qianwen-ai/skill-b',
      outcomeLabel: 'changed',
      versionLabel: 'v1.1.0 \u2192 v1.2.0',
    });
  });

  it('noop → = with the current version label', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });
    expect(vm.items[2]).toEqual({
      icon: '=',
      fullSlug: '@other-ns/skill-c',
      outcomeLabel: 'noop',
      versionLabel: 'v0.9.0',
    });
  });

  it('failed → ✗ with a [CODE] message version label', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });
    expect(vm.items[3]).toEqual({
      icon: '\u2717',
      fullSlug: '@qianwen-ai/skill-d',
      outcomeLabel: 'failed',
      versionLabel:
        '[DOWNLOAD_FAILED] Skill package download failed. Check your network and try again.',
    });
  });

  it('failedItems lists only the failed members with fullSlug/code/message', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });

    expect(vm.failedItems).toEqual([
      {
        fullSlug: '@qianwen-ai/skill-d',
        code: 'DOWNLOAD_FAILED',
        message: 'Skill package download failed. Check your network and try again.',
      },
    ]);
  });

  it('falls back to INSTALL_FAILED when a failed item carries no error', () => {
    const vm = buildPackInstallViewModel(
      packResultOf({
        overallStatus: 'failed',
        summary: { installed: 0, changed: 0, skipped: 0, failed: 1 },
        items: [{ fullSlug: '@qianwen-ai/skill-x', outcome: 'failed' }],
      }),
      { mode: 'current-dir' },
    );

    expect(vm.failedItems).toEqual([
      { fullSlug: '@qianwen-ai/skill-x', code: 'INSTALL_FAILED', message: '' },
    ]);
    expect(vm.items[0].versionLabel).toBe('[INSTALL_FAILED] ');
  });

  it('changed item with previousSlug generates an overrideNote', () => {
    const vm = buildPackInstallViewModel(
      packResultOf({
        overallStatus: 'success',
        summary: { installed: 0, changed: 1, skipped: 0, failed: 0 },
        items: [
          {
            fullSlug: '@qianwen-ai/skill-b',
            outcome: 'changed',
            version: '1.2.0',
            previousVersion: '0.5.0',
            previousSlug: '@other-ns/old-skill',
            targetDir: '/tmp/skills/skill-b',
          },
        ],
      }),
      { mode: 'current-dir' },
    );
    expect(vm.items[0].overrideNote).toBe('Replaced @other-ns/old-skill v0.5.0');
    expect(vm.items[0].versionLabel).toBe('v0.5.0 \u2192 v1.2.0');
  });

  it('changed item without previousSlug omits overrideNote', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });
    expect(vm.items[1].overrideNote).toBeUndefined();
  });
});

describe('buildPackInstallViewModel — summary counting', () => {
  it('summary counts map one-to-one onto the items', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });

    expect(vm.summary).toEqual({ installed: 1, changed: 1, skipped: 1, failed: 1 });
    expect(vm.items).toHaveLength(4);
  });

  it('the four counters sum to the item count', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });

    expect(vm.summary.installed + vm.summary.changed + vm.summary.skipped + vm.summary.failed).toBe(
      vm.items.length,
    );
  });

  it('failed members do not contribute to installed/changed/skipped (BR §5.3)', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });

    const nonFailed = vm.items.filter((i) => i.outcomeLabel !== 'failed');
    expect(vm.summary.installed + vm.summary.changed + vm.summary.skipped).toBe(nonFailed.length);
    expect(vm.summary.failed).toBe(1);
    expect(nonFailed.map((i) => i.fullSlug)).not.toContain('@qianwen-ai/skill-d');
  });

  it('carries pack/displayName/baseDir from the result', () => {
    const vm = buildPackInstallViewModel(packResultOf(), { mode: 'current-dir' });

    expect(vm.pack).toBe('qianwen-pack');
    expect(vm.displayName).toBe('Qianwen Official Pack');
    expect(vm.baseDir).toBe('/tmp/skills');
  });
});
