import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderTextSkillsInstall, renderTextPackInstall } from '../../../src/output/text/skills.js';
import type { SkillsInstallViewModel } from '../../../src/view-models/skills/index.js';
import type { PackInstallViewModel } from '../../../src/view-models/skills/index.js';

function captureStdout(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeInstallVm(overrides: Partial<SkillsInstallViewModel> = {}): SkillsInstallViewModel {
  return {
    slug: '@qianwen-ai/qianwen-find-skills',
    version: '1.0.0',
    sha256: 'abc123def456',
    outcome: 'installed',
    resultLine: '\u2713 Skill installed successfully',
    targetDir: '/tmp/skills/@qianwen-ai/qianwen-find-skills',
    modeLabel: 'Mode',
    modeValue: 'Explicit directory (--dir)',
    statusLabel: 'Installed',
    ...overrides,
  };
}

function makePackVm(overrides: Partial<PackInstallViewModel> = {}): PackInstallViewModel {
  return {
    titleIcon: '\u2713',
    titleText: 'Skill pack installed successfully',
    pack: 'qianwenai-skills-pack',
    displayName: 'QianWen AI Skills Pack',
    modeLabel: 'Mode',
    modeValue: 'Explicit directory (--dir)',
    baseDirLabel: 'Location',
    baseDir: '/tmp/skills',
    summary: { installed: 2, changed: 0, skipped: 0, failed: 0 },
    statusLabel: 'Installed',
    failedItems: [],
    items: [
      {
        icon: '\u2713',
        fullSlug: '@qianwen-ai/skill-a',
        outcomeLabel: 'installed',
        versionLabel: 'v1.0.0',
      },
      {
        icon: '\u2713',
        fullSlug: '@qianwen-ai/skill-b',
        outcomeLabel: 'installed',
        versionLabel: 'v2.0.0',
      },
    ],
    isAllNoop: false,
    ...overrides,
  };
}

describe('renderTextSkillsInstall', () => {
  it('noop output contains version and sha256', () => {
    const vm = makeInstallVm({
      outcome: 'noop',
      resultLine: '\u2713 Already installed \u2014 nothing to do',
      version: '1.2.3',
      sha256: 'deadbeef1234567890',
    });
    const out = captureStdout(() => renderTextSkillsInstall(vm));
    expect(out).toContain('version: 1.2.3');
    expect(out).toContain('sha256: deadbeef1234567890');
  });

  it('installed output contains version and sha256', () => {
    const vm = makeInstallVm({
      version: '2.0.0',
      sha256: 'aabbccdd',
    });
    const out = captureStdout(() => renderTextSkillsInstall(vm));
    expect(out).toContain('version: 2.0.0');
    expect(out).toContain('sha256: aabbccdd');
    expect(out).toContain('skill: @qianwen-ai/qianwen-find-skills');
    expect(out).toContain('location:');
    expect(out).toContain('status: Installed');
  });
});

describe('renderTextPackInstall', () => {
  it('all-noop output contains pack name, location, and per-item @provider/name slugs', () => {
    const vm = makePackVm({
      titleIcon: '\u2713',
      titleText: 'Skill pack already installed \u2014 nothing to do',
      isAllNoop: true,
      items: [
        {
          icon: '=',
          fullSlug: '@qianwen-ai/skill-a',
          outcomeLabel: 'noop',
          versionLabel: 'v1.0.0',
        },
        {
          icon: '=',
          fullSlug: '@qianwen-ai/skill-b',
          outcomeLabel: 'noop',
          versionLabel: 'v2.0.0',
        },
      ],
      summary: { installed: 0, changed: 0, skipped: 2, failed: 0 },
      pack: 'qianwenai-skills-pack',
      baseDir: '/tmp/skills',
    });
    const out = captureStdout(() => renderTextPackInstall(vm));
    expect(out).toContain('pack: qianwenai-skills-pack');
    expect(out).toContain('location: /tmp/skills');
    expect(out).toContain('nothing to do');
    expect(out).toContain('@qianwen-ai/skill-a');
    expect(out).toContain('@qianwen-ai/skill-b');
    expect(out).toContain('noop');
  });

  it('non-noop output contains full items and summary', () => {
    const vm = makePackVm();
    const out = captureStdout(() => renderTextPackInstall(vm));
    expect(out).toContain('Pack');
    expect(out).toContain('qianwenai-skills-pack');
    expect(out).toContain('@qianwen-ai/skill-a');
    expect(out).toContain('@qianwen-ai/skill-b');
    expect(out).toContain('Installed');
    expect(out).not.toContain('pack:');
  });
});
