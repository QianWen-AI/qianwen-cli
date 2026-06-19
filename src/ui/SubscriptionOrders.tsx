import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { Table } from './Table.js';
import type { Column } from './Table.js';
import { renderWithInk } from './render.js';
import { colors, theme } from './theme.js';
import type {
  OrderStatusColor,
  SubscriptionOrdersViewModel,
} from '../view-models/subscription/index.js';

export const SUBSCRIPTION_ORDERS_COLUMNS: Column[] = [
  { key: 'orderId', header: 'Order ID' },
  { key: 'orderTypeLabel', header: 'Type' },
  { key: 'orderTime', header: 'Time' },
  { key: 'amount', header: 'Amount' },
  { key: 'statusLabel', header: 'Status' },
];

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

export function buildSubscriptionOrdersRows(
  vm: SubscriptionOrdersViewModel,
): Record<string, string>[] {
  return vm.rows.map((r) => ({
    orderId: r.orderId,
    orderTypeLabel: r.orderTypeLabel,
    orderTime: r.orderTime,
    amount: r.amountDisplay,
    statusLabel: colorizeOrderStatus(
      r.detailError ? `${r.statusLabel} (!)` : r.statusLabel,
      r.statusColor,
    ),
  }));
}

export interface SubscriptionOrdersInkProps {
  vm: SubscriptionOrdersViewModel;
}

export function SubscriptionOrdersInk({ vm }: SubscriptionOrdersInkProps) {
  if (vm.isEmpty) {
    return (
      <Section title="Subscription Orders" footer={vm.pagingNote}>
        <Box paddingLeft={2}>
          <Text>{vm.emptyPlaceholder}</Text>
        </Box>
      </Section>
    );
  }

  const data = vm.rows.map((r) => ({
    orderId: r.orderId,
    orderTypeLabel: r.orderTypeLabel,
    orderTime: r.orderTime,
    amount: r.amountDisplay,
    statusLabel: colorizeOrderStatus(
      r.detailError ? `${r.statusLabel} (!)` : r.statusLabel,
      r.statusColor,
    ),
  }));

  return (
    <Section title="Subscription Orders" footer={vm.pagingNote}>
      <Box flexDirection="column">
        <Table columns={SUBSCRIPTION_ORDERS_COLUMNS} data={data} paddingLeft={0} />
        {vm.diagnostics.length > 0 && (
          <Text color={colors.muted}>
            {vm.diagnostics.length} detail call(s) failed \u2014 see --format json
          </Text>
        )}
      </Box>
    </Section>
  );
}

export async function renderSubscriptionOrdersInk(vm: SubscriptionOrdersViewModel): Promise<void> {
  await renderWithInk(<SubscriptionOrdersInk vm={vm} />);
}
