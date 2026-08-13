/**
 * Skills install view-model — pure mapping from the install result to
 * render-friendly fields. No side effects (Clean Architecture layer 2).
 */

import type { SkillsInstallResult } from '../../types/skills.js';

const EM_DASH = '\u2014';

/**
 * Outcome banner shared by text and TUI (UX copy for
 * installed/updated; noop is undefined in the spec so its existing wording
 * is kept under the same "\u2713 <summary>" banner format).
 */
const RESULT_LINES: Record<SkillsInstallResult['outcome'], string> = {
  installed: '\u2713 Skill installed successfully',
  updated: '\u2713 Skill updated successfully',
  noop: '\u2713 Already installed \u2014 nothing to do',
};

/** How the final install directory was chosen (drives the summary Mode/Status rows). */
export type SkillsInstallMode = 'current-dir' | 'agent' | 'explicit-dir';

export interface SkillsInstallContext {
  mode: SkillsInstallMode;
  /** Present only when mode is 'agent'. */
  agentDisplayName?: string;
}

export interface SkillsInstallViewModel {
  slug: string;
  outcome: SkillsInstallResult['outcome'];
  resultLine: string;
  targetDir: string;
  modeLabel: 'Mode' | 'Agent';
  modeValue: string;
  statusLabel: string;
  /** Pre-worded downgrade warning shared by text and TUI; absent when none. */
  downgradeWarning?: string;
}

export function buildSkillsInstallViewModel(
  data: SkillsInstallResult,
  context: SkillsInstallContext,
): SkillsInstallViewModel {
  const isAgent = context.mode === 'agent';
  return {
    slug: data.slug,
    outcome: data.outcome,
    resultLine: RESULT_LINES[data.outcome],
    targetDir: data.targetDir,
    modeLabel: isAgent ? 'Agent' : 'Mode',
    modeValue: isAgent
      ? context.agentDisplayName || EM_DASH
      : context.mode === 'explicit-dir'
        ? 'Explicit directory (--dir)'
        : 'Current directory',
    statusLabel: isAgent ? 'Ready to use in this project' : 'Installed',
    ...(data.downgrade
      ? {
          downgradeWarning:
            `downgraded from ${data.downgrade.from} to ${data.downgrade.to} ` +
            '(local version was newer than the hub release)',
        }
      : {}),
  };
}
