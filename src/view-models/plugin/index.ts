/**
 * Plugin list view-model — pure mapping from resolved install entries to
 * render-friendly rows. No side effects (Clean Architecture layer 2): all
 * filesystem probing (does the package dir exist? what command does it
 * contribute?) happens in the command layer and is passed in pre-resolved.
 */

import type { PluginSource } from '../../plugins/manifest.js';

const EM_DASH = '\u2014';

/** One install entry with its command layer probe results folded in. */
export interface ResolvedPluginEntry {
  name: string;
  version: string;
  enabled: boolean;
  source: PluginSource;
  /** Top-level command the plugin contributes; em dash if unresolved/broken. */
  command?: string;
  /** False when the package dir or its manifest is missing on disk. */
  installed: boolean;
  minCliVersion?: string;
  compatible: boolean;
  status?: PluginListRowViewModel['status'];
}

export interface PluginListRowViewModel {
  name: string;
  version: string;
  command: string;
  source: PluginSource;
  /** broken → disabled → incompatible → enabled. */
  status: 'enabled' | 'disabled' | 'incompatible' | 'broken' | 'pending' | 'installed' | 'outdated';
}

export interface PluginListViewModel {
  rows: PluginListRowViewModel[];
  totalCount: number;
  isEmpty: boolean;
}

export function buildPluginListViewModel(entries: ResolvedPluginEntry[]): PluginListViewModel {
  const rows = entries.map((e) => ({
    name: e.name,
    version: e.version || EM_DASH,
    command: e.command || EM_DASH,
    source: e.source,
    status: (e.status ??
      (!e.installed
        ? 'broken'
        : !e.enabled
          ? 'disabled'
          : e.compatible
            ? 'enabled'
            : 'incompatible')) as
      | 'enabled'
      | 'disabled'
      | 'incompatible'
      | 'broken'
      | 'pending'
      | 'installed'
      | 'outdated',
  }));
  return { rows, totalCount: rows.length, isEmpty: rows.length === 0 };
}
