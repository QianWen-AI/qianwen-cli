/**
 * Tests for the skills install view-model — scope-dependent statusLabel
 * wording and context shape compatibility.
 */
import { describe, it, expect } from 'vitest';
import { buildSkillsInstallViewModel } from '../../../src/view-models/skills/index.js';
import type { SkillsInstallResult } from '../../../src/types/skills.js';

const installed: SkillsInstallResult = {
  slug: 'pdf-extractor',
  version: '1.2.0',
  outcome: 'installed',
  targetDir: '/tmp/skills/pdf-extractor',
  securityStatus: 'safe',
  securityLabel: 'safe',
  sha256: 'a'.repeat(64),
};

describe('buildSkillsInstallViewModel — statusLabel by scope', () => {
  it('agent mode + project scope → Ready to use in this project', () => {
    const vm = buildSkillsInstallViewModel(installed, {
      mode: 'agent',
      agentDisplayName: 'Codex',
      scope: 'project',
    });
    expect(vm.statusLabel).toBe('Ready to use in this project');
  });

  it('agent mode + global scope → Ready to use globally', () => {
    const vm = buildSkillsInstallViewModel(installed, {
      mode: 'agent',
      agentDisplayName: 'Codex',
      scope: 'global',
    });
    expect(vm.statusLabel).toBe('Ready to use globally');
  });

  it('agent mode without scope keeps the project wording (backward compatible)', () => {
    const vm = buildSkillsInstallViewModel(installed, {
      mode: 'agent',
      agentDisplayName: 'Codex',
    });
    expect(vm.statusLabel).toBe('Ready to use in this project');
  });

  it('current-dir mode → Installed regardless of scope', () => {
    const vm = buildSkillsInstallViewModel(installed, { mode: 'current-dir', scope: 'global' });
    expect(vm.statusLabel).toBe('Installed');
  });

  it('explicit-dir mode → Installed', () => {
    const vm = buildSkillsInstallViewModel(installed, { mode: 'explicit-dir' });
    expect(vm.statusLabel).toBe('Installed');
  });
});

describe('buildSkillsInstallViewModel — context shape compatibility', () => {
  it('accepts the existing minimal context without agentDisplayName (regression)', () => {
    const vm = buildSkillsInstallViewModel(installed, { mode: 'current-dir' });
    expect(vm.slug).toBe('pdf-extractor');
    expect(vm.resultLine).toBe('\u2713 Skill installed successfully');
    expect(vm.modeLabel).toBe('Mode');
    expect(vm.modeValue).toBe('Current directory');
    expect(vm.statusLabel).toBe('Installed');
  });
});

describe('buildSkillsInstallViewModel — apiKeyNotice', () => {
  it('sets apiKeyNotice when requiresApiKey is true', () => {
    const vm = buildSkillsInstallViewModel(
      { ...installed, requiresApiKey: true },
      { mode: 'current-dir' },
    );
    expect(vm.apiKeyNotice).toBe('This skill requires an API Key to use.');
  });

  it('omits apiKeyNotice when requiresApiKey is false', () => {
    const vm = buildSkillsInstallViewModel(
      { ...installed, requiresApiKey: false },
      { mode: 'current-dir' },
    );
    expect(vm.apiKeyNotice).toBeUndefined();
  });

  it('omits apiKeyNotice when requiresApiKey is absent', () => {
    const vm = buildSkillsInstallViewModel(installed, { mode: 'current-dir' });
    expect(vm.apiKeyNotice).toBeUndefined();
  });
});

describe('buildSkillsInstallViewModel — overrideNote', () => {
  it('sets overrideNote when overwritten with previousSlug', () => {
    const vm = buildSkillsInstallViewModel(
      {
        ...installed,
        overwritten: true,
        previousSlug: '@other-ns/pdf-extractor',
        previousVersion: '0.5.0',
      },
      { mode: 'current-dir' },
    );
    expect(vm.overrideNote).toBe('Replaced @other-ns/pdf-extractor 0.5.0');
  });

  it('omits overrideNote when not overwritten', () => {
    const vm = buildSkillsInstallViewModel(installed, { mode: 'current-dir' });
    expect(vm.overrideNote).toBeUndefined();
  });
});
