import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { Table } from './Table.js';
import type { Column } from './Table.js';
import { renderWithInk } from './render.js';
import { colors, theme } from './theme.js';
import { useTerminalSize } from './useTerminalSize.js';
import { TokenPlanSeatDetails } from './TokenPlanSeatDetails.js';
import type {
  CreditPackSectionViewModel,
  OrderStatusColor,
  RecentOrdersSectionViewModel,
  SubscriptionStatusViewModel,
  TokenPlanSectionViewModel,
} from '../view-models/subscription/index.js';

export interface SubscriptionStatusInkProps {
  vm: SubscriptionStatusViewModel;
}

const DIVIDER_CHAR = '═';
const MIN_DIVIDER_WIDTH = 40;

function sectionDivider(title: string, width: number): string {
  const safe = Math.max(MIN_DIVIDER_WIDTH, width);
  const label = ` ${title} `;
  const lead = DIVIDER_CHAR.repeat(3);
  const tail = Math.max(3, safe - lead.length - label.length);
  return `${lead}${label}${DIVIDER_CHAR.repeat(tail)}`;
}

function statusColor(value: string): string | undefined {
  if (value === 'Active') return colors.success;
  if (value === 'Expired') return colors.error;
  return undefined;
}

function LegacyTokenPlanSection({
  section,
  width,
}: {
  section: TokenPlanSectionViewModel;
  width: number;
}) {
  return (
    <Box flexDirection="column">
      <Text color={colors.brand}>{sectionDivider('Token Plan', width)}</Text>
      <Box>
        <Text>Status: </Text>
        <Text color={statusColor(section.status)}>{section.status}</Text>
        <Text>
          {'    '}Auto-Renew: {section.autoRenew}
          {'    '}Expires: {section.expires}
        </Text>
      </Box>
      <Text> </Text>
      {section.tiers.map((tier) => (
        <Box flexDirection="column" key={tier.label}>
          <Text>{tier.label}</Text>
          <Text> {tier.bar}</Text>
        </Box>
      ))}
    </Box>
  );
}

function TeamSeatUsage({ section }: { section: TokenPlanSectionViewModel }) {
  if (section.tiers.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Text bold>Seat Usage</Text>
      {section.tiers.map((tier) => (
        <Box flexDirection="column" paddingLeft={2} key={tier.label}>
          <Text>{tier.label}</Text>
          <Text>Remaining {tier.bar}</Text>
        </Box>
      ))}
    </Box>
  );
}

function CreditPackSection({
  section,
  width,
}: {
  section: CreditPackSectionViewModel;
  width: number;
}) {
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text color={colors.brand}>{sectionDivider('Add-on Credit Packs', width)}</Text>
      <Text>
        {section.count} pack{section.count === 1 ? '' : 's'} Total Remaining:{' '}
        {section.totalRemaining}
      </Text>
      <Text> </Text>
      <Text color={colors.muted}>
        {'ID'.padEnd(32)}
        {'Remaining'.padEnd(24)}Expires
      </Text>
      {section.packs.map((pack) => (
        <Box flexDirection="column" key={pack.id}>
          <Text>
            {pack.id.padEnd(32)}
            {pack.remaining.padEnd(24)}Expires: {pack.expires}
          </Text>
          <Text> {pack.bar}</Text>
        </Box>
      ))}
    </Box>
  );
}

function colorizeOrderStatus(label: string, color: OrderStatusColor): string {
  switch (color) {
    case 'green':
      return theme.success(label);
    case 'orange':
      return theme.warning(label);
    case 'gray':
      return theme.muted(label);
    default:
      return label;
  }
}

const RECENT_ORDERS_COLUMNS: Column[] = [
  { key: 'id', header: 'Order ID' },
  { key: 'typeLabel', header: 'Type' },
  { key: 'date', header: 'Date' },
  { key: 'amount', header: 'Amount' },
  { key: 'status', header: 'Status' },
];

function RecentOrdersSection({
  section,
  width,
}: {
  section: RecentOrdersSectionViewModel;
  width: number;
}) {
  const title = `Recent Token Plan Orders (latest ${section.orders.length})`;
  const data = section.orders.map((o) => ({
    ...o,
    status: colorizeOrderStatus(o.statusLabel, o.statusColor),
  }));
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text color={colors.brand}>{sectionDivider(title, width)}</Text>
      <Table columns={RECENT_ORDERS_COLUMNS} data={data} paddingLeft={0} />
    </Box>
  );
}

function FlatFallback({ vm }: { vm: SubscriptionStatusViewModel }) {
  return (
    <>
      {vm.fields.map((f) => (
        <Text key={f.label}>
          {f.label.padEnd(20)}
          {f.value}
        </Text>
      ))}
      {vm.quota && (
        <>
          <Text> </Text>
          <Text>
            {'Quota'.padEnd(20)}
            {vm.quota.display}
          </Text>
          <Text>
            {''.padEnd(20)}
            {vm.quota.bar}
          </Text>
        </>
      )}
    </>
  );
}

export function SubscriptionStatusInk({ vm }: SubscriptionStatusInkProps) {
  const { columns } = useTerminalSize();
  const width = Math.max(MIN_DIVIDER_WIDTH, (columns ?? 80) - 4);

  if (vm.banner) {
    return (
      <Section title="Subscription Status">
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={colors.error}>{vm.banner}</Text>
          {vm.diagnostics.map((diagnostic, index) => (
            <Text key={`${diagnostic.api}-${index}`} color={colors.muted}>
              · {diagnostic.errorMessage}
            </Text>
          ))}
        </Box>
      </Section>
    );
  }

  const editionSections = vm.sections.filter((section) => section.id.startsWith('tokenplan-'));
  const hasEditionSections = editionSections.length > 0;

  return (
    <Section title="Subscription Status" footer={vm.footnote ?? undefined}>
      <Box flexDirection="column" paddingLeft={2}>
        {hasEditionSections ? (
          <>
            <Text color={colors.brand}>{sectionDivider('Token Plans', width)}</Text>
            {editionSections.map((section) => (
              <Box key={section.id} flexDirection="column" paddingLeft={2} marginBottom={1}>
                <Text bold>{section.title}</Text>
                <Box flexDirection="column" paddingLeft={2}>
                  {section.fields.map((field) => (
                    <Text key={field.label}>
                      {field.label.padEnd(18)}
                      {field.value}
                    </Text>
                  ))}
                </Box>
                {section.id === 'tokenplan-team' && vm.tokenPlanSection && (
                  <TeamSeatUsage section={vm.tokenPlanSection} />
                )}
                {section.id === 'tokenplan-team' && vm.seatDetails && (
                  <Box paddingLeft={2} flexDirection="column">
                    <TokenPlanSeatDetails details={vm.seatDetails} indent={8} />
                  </Box>
                )}
              </Box>
            ))}
          </>
        ) : vm.tokenPlanSection ? (
          <LegacyTokenPlanSection section={vm.tokenPlanSection} width={width} />
        ) : (
          <FlatFallback vm={vm} />
        )}
        {vm.creditPackSection && <CreditPackSection section={vm.creditPackSection} width={width} />}
        {vm.recentOrdersSection && (
          <RecentOrdersSection section={vm.recentOrdersSection} width={width} />
        )}
      </Box>
    </Section>
  );
}

export async function renderSubscriptionStatusInk(vm: SubscriptionStatusViewModel): Promise<void> {
  await renderWithInk(<SubscriptionStatusInk vm={vm} />);
}
