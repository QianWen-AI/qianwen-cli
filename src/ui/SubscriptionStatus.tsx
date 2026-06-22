import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { Table } from './Table.js';
import type { Column } from './Table.js';
import { renderWithInk } from './render.js';
import { colors, theme } from './theme.js';
import { useTerminalSize } from './useTerminalSize.js';
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

function TokenPlanSection({
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
      <Text color={colors.brand}>{sectionDivider('Credit Pack', width)}</Text>
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
  const title = `Recent Orders (latest ${section.orders.length})`;
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
          {vm.diagnostics.map((d) => (
            <Text key={d.api} color={colors.muted}>
              · {d.api}: {d.errorCode} {d.errorMessage}
            </Text>
          ))}
        </Box>
      </Section>
    );
  }

  const hasNewSections =
    vm.tokenPlanSection !== null ||
    vm.creditPackSection !== null ||
    vm.recentOrdersSection !== null;

  return (
    <Section title="Subscription Status" footer={vm.footnote ?? undefined}>
      <Box flexDirection="column" paddingLeft={2}>
        {hasNewSections ? (
          <>
            {vm.tokenPlanSection && (
              <TokenPlanSection section={vm.tokenPlanSection} width={width} />
            )}
            {vm.creditPackSection && (
              <CreditPackSection section={vm.creditPackSection} width={width} />
            )}
            {vm.recentOrdersSection && (
              <RecentOrdersSection section={vm.recentOrdersSection} width={width} />
            )}
          </>
        ) : (
          <FlatFallback vm={vm} />
        )}
      </Box>
    </Section>
  );
}

export async function renderSubscriptionStatusInk(vm: SubscriptionStatusViewModel): Promise<void> {
  await renderWithInk(<SubscriptionStatusInk vm={vm} />);
}
