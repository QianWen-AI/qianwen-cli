/**
 * Skills pack-install view-model — pure mapping from the pack install result
 * to render-friendly fields. No side effects (Clean Architecture layer 2).
 */

import type { PackInstallResult, PackInstallSummary, PackItemResult } from '../../types/skills.js';
import type { AgentScope } from '../../utils/agent-dirs.js';

const EM_DASH = '\u2014';
const CHECK = '\u2713';
const WARNING = '\u26a0';
const CROSS = '\u2717';
const TILDE = '~';
const EQUALS = '=';
const ARROW = '\u2192';

/** How the final install directory was chosen (drives the summary Mode/Status rows). */
export type PackInstallMode = 'current-dir' | 'agent' | 'explicit-dir';

export interface PackInstallContext {
  mode: PackInstallMode;
  /** Present only when mode is 'agent'. */
  agentDisplayName?: string;
  /** Present only when mode is 'agent'; defaults to the project wording. */
  scope?: AgentScope;
}

export interface PackItemRowViewModel {
  icon: '\u2713' | '~' | '=' | '\u2717';
  fullSlug: string;
  /** 'installed' | 'changed' | 'noop' | 'failed'. */
  outcomeLabel: string;
  /** 'v1.2.0', 'v1.1.0 → v1.2.0' or '[CODE] message'. */
  versionLabel: string;
  /** Pre-worded slug-conflict override note (e.g. 'Replaced @old/slug v1.0.0'); absent when none. */
  overrideNote?: string;
}

export interface PackInstallViewModel {
  titleIcon: '\u2713' | '\u26a0' | '\u2717';
  titleText: string;
  pack: string;
  displayName: string;
  /** 'Agent' in agent mode, 'Mode' otherwise (BR §4.4). */
  modeLabel: 'Agent' | 'Mode';
  /** Agent display name, 'Current directory' or 'Explicit directory (--dir)'. */
  modeValue: string;
  /** 'Base directory' in agent mode, 'Location' otherwise (BR §4.4). */
  baseDirLabel: 'Base directory' | 'Location';
  baseDir: string;
  summary: PackInstallSummary;
  statusLabel: string;
  failedItems: Array<{ fullSlug: string; code: string; message: string }>;
  items: PackItemRowViewModel[];
  /** Every member was already installed — nothing was downloaded or written. */
  isAllNoop: boolean;
}

export function buildPackInstallViewModel(
  data: PackInstallResult,
  context: PackInstallContext,
): PackInstallViewModel {
  const isAllNoop = data.items.length > 0 && data.items.every((i) => i.outcome === 'noop');
  const isAgent = context.mode === 'agent';

  return {
    titleIcon:
      data.overallStatus === 'success' ? CHECK : data.overallStatus === 'partial' ? WARNING : CROSS,
    titleText: packTitleText(data.overallStatus, isAllNoop, data.summary),
    pack: data.pack,
    displayName: data.displayName,
    modeLabel: isAgent ? 'Agent' : 'Mode',
    modeValue: isAgent
      ? context.agentDisplayName || EM_DASH
      : context.mode === 'explicit-dir'
        ? 'Explicit directory (--dir)'
        : 'Current directory',
    baseDirLabel: isAgent ? 'Base directory' : 'Location',
    baseDir: data.baseDir,
    summary: data.summary,
    statusLabel: packStatusLabel(data.overallStatus, isAgent, context.scope, data.summary),
    failedItems: data.items
      .filter((i) => i.outcome === 'failed')
      .map((i) => ({
        fullSlug: i.fullSlug,
        code: i.error?.code ?? 'INSTALL_FAILED',
        message: i.error?.message ?? '',
      })),
    items: data.items.map(itemRow),
    isAllNoop,
  };
}

function packTitleText(
  overallStatus: PackInstallResult['overallStatus'],
  isAllNoop: boolean,
  summary: PackInstallSummary,
): string {
  if (overallStatus === 'success') {
    return isAllNoop
      ? `Skill pack already installed ${EM_DASH} nothing to do`
      : 'Skill pack installed successfully';
  }
  if (overallStatus === 'partial') {
    if (summary.installed + summary.changed > 0) {
      return 'Skill pack installed with some failures';
    }
    return 'No skills were installed';
  }
  return 'Skill pack installation failed';
}

function packStatusLabel(
  overallStatus: PackInstallResult['overallStatus'],
  isAgent: boolean,
  scope: AgentScope | undefined,
  summary?: PackInstallSummary,
): string {
  if (overallStatus === 'partial') {
    if (summary && summary.installed + summary.changed === 0) {
      return 'No skills were installed';
    }
    return 'Completed with failures';
  }
  if (overallStatus === 'failed') return 'No skills were installed';
  if (isAgent) return scope === 'global' ? 'Ready to use globally' : 'Ready to use in this project';
  return 'Installed';
}

function itemRow(item: PackItemResult): PackItemRowViewModel {
  if (item.outcome === 'failed') {
    return {
      icon: CROSS,
      fullSlug: item.fullSlug,
      outcomeLabel: 'failed',
      versionLabel: `[${item.error?.code ?? 'INSTALL_FAILED'}] ${item.error?.message ?? ''}`,
    };
  }
  const version = item.version ? `v${item.version}` : '';
  const versionLabel =
    item.outcome === 'changed' && item.previousVersion
      ? `v${item.previousVersion} ${ARROW} ${version}`
      : version;
  const overrideNote = item.previousSlug
    ? `Replaced ${item.previousSlug}${item.previousVersion ? ` v${item.previousVersion}` : ''}`
    : undefined;
  return {
    icon: item.outcome === 'installed' ? CHECK : item.outcome === 'changed' ? TILDE : EQUALS,
    fullSlug: item.fullSlug,
    outcomeLabel: item.outcome,
    versionLabel,
    ...(overrideNote !== undefined ? { overrideNote } : {}),
  };
}
