import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { renderWithInk } from './render.js';
import { colors } from './theme.js';
import { useTerminalSize } from './useTerminalSize.js';
import type { TokenPlanStatusViewModel } from '../view-models/subscription/tokenplan-status.js';
import { TokenPlanDetailTables } from './TokenPlanDetailTables.js';
import { truncateByDisplayWidth } from './textWrap.js';

export interface SubscriptionTokenPlanStatusInkProps {
  vm: TokenPlanStatusViewModel;
}

export function SubscriptionTokenPlanStatusInk({ vm }: SubscriptionTokenPlanStatusInkProps) {
  const { columns } = useTerminalSize();
  const width = Math.max(1, columns - 4);
  const hasData =
    vm.editionSections.length > 0 || vm.header !== undefined || (vm.seatLines?.length ?? 0) > 0;
  if (!hasData && vm.diagnostics.length > 0) {
    return (
      <Section title="TOKEN PLAN STATUS">
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={colors.error}>Token Plan subscription data unavailable</Text>
          {vm.diagnostics.map((diagnostic, index) => (
            <Text key={`${diagnostic.api}-${index}`} color={colors.muted}>
              · {diagnostic.errorMessage}
            </Text>
          ))}
        </Box>
      </Section>
    );
  }
  return (
    <Section title="TOKEN PLAN STATUS" footer={vm.footnote ?? undefined} maxWidth={columns}>
      <Box flexDirection="column" width={Math.max(1, columns - 2)}>
        {vm.editionSections.map((section, index) => (
          <Box key={section.edition} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <TokenPlanEditionInk section={section} />
          </Box>
        ))}
        {vm.editionSections.length === 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            {vm.header && (
              <>
                <Text>
                  {'Product'.padEnd(16)}
                  {vm.header.product}
                </Text>
                <Text>
                  {'Period'.padEnd(16)}
                  {vm.header.period}
                </Text>
                <Text>
                  {'Auto-Renew'.padEnd(16)}
                  {vm.header.autoRenew}
                </Text>
                <Text>
                  {'Renewable'.padEnd(16)}
                  {vm.header.renewable}
                </Text>
              </>
            )}
            <TokenPlanDetailTables
              tables={vm.detailTables ?? []}
              paddingLeft={0}
              maxTotalWidth={width}
              recordTitleGap={0}
            />
          </Box>
        )}
        {vm.warnings && vm.warnings.length > 0 && (
          <Box flexDirection="column" paddingLeft={2} marginTop={1}>
            {vm.warnings.map((warning, index) => (
              <Text key={index} color={colors.warning}>
                {warning}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </Section>
  );
}

function TokenPlanEditionInk({
  section,
}: {
  section: TokenPlanStatusViewModel['editionSections'][number];
}) {
  const { columns } = useTerminalSize();
  return (
    <Box flexDirection="column">
      <Text bold>{section.title}</Text>
      <Box flexDirection="column" paddingLeft={2}>
        {section.fields.map((field) => (
          <Text key={field.label}>
            {field.label.padEnd(18)}
            {field.value}
          </Text>
        ))}
        <TokenPlanDetailTables
          tables={section.detailTables ?? []}
          paddingLeft={0}
          maxTotalWidth={Math.max(1, columns - 4)}
          recordTitleGap={0}
        />
      </Box>
    </Box>
  );
}

function TokenPlanEditionChunkInk({
  section,
  first,
}: {
  section: TokenPlanStatusViewModel['editionSections'][number];
  first: boolean;
}) {
  const { columns } = useTerminalSize();
  const content = (
    <Box flexDirection="column" width={Math.max(1, columns - 2)}>
      <TokenPlanEditionInk section={section} />
    </Box>
  );
  return first ? (
    <Section title="TOKEN PLAN STATUS" maxWidth={columns}>
      {content}
    </Section>
  ) : (
    <Box flexDirection="column" paddingLeft={2}>
      {content}
    </Box>
  );
}

function TokenPlanNotesInk({ vm }: SubscriptionTokenPlanStatusInkProps) {
  const { columns } = useTerminalSize();
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {vm.warnings?.length ? (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {vm.warnings.map((warning, index) => (
            <Text key={index} color={colors.warning}>
              {warning}
            </Text>
          ))}
        </Box>
      ) : null}
      {vm.footnote && (
        <>
          <Text color={colors.border} wrap="truncate-end">
            {'─'.repeat(Math.max(0, columns - 2))}
          </Text>
          <Text color={colors.muted} wrap="truncate-end">
            {truncateByDisplayWidth(vm.footnote, Math.max(1, columns - 2))}
          </Text>
        </>
      )}
    </Box>
  );
}

export async function renderSubscriptionTokenPlanStatusInk(
  vm: TokenPlanStatusViewModel,
): Promise<void> {
  if (!vm.editionSections.some((section) => section.purchaseHint)) {
    await renderWithInk(<SubscriptionTokenPlanStatusInk vm={vm} />);
    return;
  }
  // Flush each edition before its raw command line so narrow terminals do not
  // insert hard line breaks into the copyable purchase example.
  for (const [index, section] of vm.editionSections.entries()) {
    if (index > 0) process.stdout.write('\n');
    await renderWithInk(<TokenPlanEditionChunkInk section={section} first={index === 0} />, {
      trailingNewline: false,
    });
    if (section.purchaseHint) {
      process.stdout.write(
        section.purchaseHint
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n') + '\n',
      );
    }
  }
  if (vm.warnings?.length || vm.footnote) {
    await renderWithInk(<TokenPlanNotesInk vm={vm} />, { trailingNewline: false });
  }
}
