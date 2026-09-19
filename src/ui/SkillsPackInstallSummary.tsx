/**
 * `skills pack-install` TUI — the pre-download confirmation page (BR §3.4.1)
 * and the final summary view (BR §4.3): title banner, per-member result rows,
 * summary field table and the failed-skills list. The all-noop special case
 * renders the title banner only.
 */

import React from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Section } from './Section.js';
import { renderInteractive, renderWithInk } from './render.js';
import type { PackInstallPlan } from '../services/skills-pack-service.js';
import type { PackInstallViewModel } from '../view-models/skills/index.js';

// ── Confirmation page (BR §3.4.1) ────────────────────────────────────────────

export interface PackInstallConfirmProps {
  plan: PackInstallPlan;
  onResult: (confirmed: boolean) => void;
}

/** Planned-change counts. Enter or `y` proceeds; `n`, Esc or Ctrl+C cancels. */
export function PackInstallConfirm({ plan, onResult }: PackInstallConfirmProps) {
  const { exit } = useApp();

  useInput((rawInput, key) => {
    const input = rawInput.replace(/[\r\n]+$/, '');
    if (input === 'c' && key.ctrl) {
      onResult(false);
      exit();
      return;
    }
    if (key.escape) {
      onResult(false);
      exit();
      return;
    }
    if (key.return || input === 'y' || input === 'Y') {
      onResult(true);
      exit();
      return;
    }
    if (input === 'n' || input === 'N') {
      onResult(false);
      exit();
    }
  });

  const rows: Array<[string, number]> = [
    ['Install', plan.install],
    ['Change', plan.change],
    ['No change', plan.noop],
  ];
  if (plan.failed > 0) {
    rows.push(['Failed (precheck)', plan.failed]);
  }

  return (
    <Section title="Review planned changes">
      <Box flexDirection="column" paddingLeft={2} marginTop={1}>
        {rows.map(([label, count]) => (
          <Text key={label}>
            <Text dimColor>{label.padEnd(12)}</Text>
            {count}
          </Text>
        ))}
        {plan.override > 0 ? (
          <Box flexDirection="column">
            <Text color="yellow">
              <Text dimColor>{'Override'.padEnd(12)}</Text>
              {plan.override} skill(s) will replace existing different skills
            </Text>
            {plan.overrideMembers.map((m) => (
              <Text key={m.skillName} color="yellow">
                {''.padEnd(12)}
                {m.skillName}: {m.previousSlug} {m.previousVersion} {'->'} {m.fullSlug} {m.version}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text>Proceed? (Y/n)</Text>
        </Box>
      </Box>
    </Section>
  );
}

export async function promptPackInstallConfirm(plan: PackInstallPlan): Promise<boolean> {
  let confirmed = false;

  const element = React.createElement(PackInstallConfirm, {
    plan,
    onResult: (value: boolean) => {
      confirmed = value;
    },
  });

  await renderInteractive(element, { altScreen: false });
  return confirmed;
}

// ── Final summary (BR §4.3) ─────────────────────────────────────────────────

export interface SkillsPackInstallSummaryProps {
  vm: PackInstallViewModel;
  showItems?: boolean;
}

const TITLE_COLORS: Record<PackInstallViewModel['titleIcon'], string> = {
  '\u2713': 'green',
  '\u26a0': 'yellow',
  '\u2717': 'red',
};

const ROW_COLORS: Record<PackInstallViewModel['items'][number]['icon'], string> = {
  '\u2713': 'green',
  '~': 'green',
  '=': 'yellow',
  '\u2717': 'red',
};

export function SkillsPackInstallSummary({ vm, showItems = true }: SkillsPackInstallSummaryProps) {
  const rows: Array<[string, string]> = [
    ['Pack', vm.pack],
    [vm.modeLabel, vm.modeValue],
    [vm.baseDirLabel, vm.baseDir],
    ['Installed', String(vm.summary.installed)],
    ['Changed', String(vm.summary.changed)],
    ['Skipped', String(vm.summary.skipped)],
    ['Failed', String(vm.summary.failed)],
    ['Status', vm.statusLabel],
  ];

  return (
    <Section title="Skills Pack Install">
      <Box flexDirection="column">
        <Text color={TITLE_COLORS[vm.titleIcon]}>{`${vm.titleIcon} ${vm.titleText}`}</Text>
        {vm.isAllNoop ? null : (
          <Box flexDirection="column" marginTop={1}>
            {showItems
              ? vm.items.map((item) => (
                  <Text key={item.fullSlug} color={ROW_COLORS[item.icon]}>
                    {`${item.icon} ${item.fullSlug}  ${item.outcomeLabel}  ${item.versionLabel}`}
                  </Text>
                ))
              : null}
            <Box flexDirection="column" marginTop={1}>
              {rows.map(([label, value]) => (
                <Text key={label}>
                  <Text dimColor>{label.padEnd(12)}</Text>
                  {value}
                </Text>
              ))}
            </Box>
            {vm.failedItems.length > 0 ? (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color="red">
                  Failed skills
                </Text>
                {vm.failedItems.map((failed) => (
                  <Text key={failed.fullSlug} color="red">
                    {`\u2717 ${failed.fullSlug}  [${failed.code}] ${failed.message}`}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
        )}
      </Box>
    </Section>
  );
}

export async function renderSkillsPackInstallInk(
  vm: PackInstallViewModel,
  options?: { showItems?: boolean },
): Promise<void> {
  await renderWithInk(<SkillsPackInstallSummary vm={vm} showItems={options?.showItems} />);
}
