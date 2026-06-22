import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { Table } from './Table.js';
import { InteractiveTable } from './InteractiveTable.js';
import { renderWithInk, renderInteractive } from './render.js';
import type { BillingBreakdownViewModel } from '../view-models/billing/index.js';
import type { ViewContext } from '../view-models/billing/shared.js';
import type { ConsumeBreakdownByPeriods } from '../types/billing-extra.js';
import { formatMoney } from '../view-models/billing/shared.js';

export interface BillingBreakdownInkProps {
  vm: BillingBreakdownViewModel;
}

export function BillingBreakdownInk({ vm }: BillingBreakdownInkProps) {
  const data = vm.rows.map((r) => ({
    label: r.cells.label,
    amount: r.cells.amount,
  }));
  data.push({ label: 'TOTAL', amount: vm.total.display });

  const columns = vm.columns.map((c) => ({
    key: c.key as string,
    header: c.header,
  }));

  const groupByHeader = vm.columns[0]?.header ?? '';
  const subtitle = `${groupByHeader} \u00B7 ${vm.period} \u00B7 ${vm.chargeType}`;
  const footer = vm.truncationNotice ?? undefined;

  return (
    <Section title="Consumption Breakdown" subtitle={subtitle} footer={footer}>
      <Box flexDirection="column">
        {data.length > 0 ? (
          <Table columns={columns} data={data} paddingLeft={0} />
        ) : (
          <Text>No data.</Text>
        )}
      </Box>
    </Section>
  );
}

export async function renderBillingBreakdownInk(vm: BillingBreakdownViewModel): Promise<void> {
  await renderWithInk(<BillingBreakdownInk vm={vm} />);
}

export async function renderBillingBreakdownByPeriodsInk(
  data: ConsumeBreakdownByPeriods,
  ctx: ViewContext,
): Promise<void> {
  const { slices, groupBy } = data;
  const groupHeader = groupBy === 'api-key' ? 'API Key' : 'Model';

  const columns = [
    { key: 'label', header: groupHeader },
    { key: 'amount', header: 'Amount' },
  ];

  // Each page = one period slice; perPage = max rows across slices
  const maxRows = Math.max(...slices.map((s) => s.rows.length + 1)); // +1 for TOTAL row
  const totalItems = slices.length * maxRows;

  const buildPageRows = (page: number): Record<string, string>[] => {
    const slice = slices[page - 1];
    if (!slice) return [];
    const rows = slice.rows.map((r) => ({
      label: r.groupLabel,
      amount: formatMoney(r.amount, ctx),
    }));
    rows.push({ label: 'TOTAL', amount: formatMoney(slice.totalAmount, ctx) });
    return rows;
  };

  const initialRows = buildPageRows(1);
  const title = 'Consumption Breakdown';
  const granLabel = data.granularity === 'month' ? 'Monthly' : 'Daily';
  const subtitle = `${groupHeader} \u00b7 ${data.dateRange.from} \u2192 ${data.dateRange.to} \u00b7 ${granLabel}`;
  const pageLabels = slices.map((s) => s.period);

  const loadPage = async (page: number) => buildPageRows(page);

  await renderInteractive(
    <InteractiveTable
      columns={columns}
      totalItems={totalItems}
      perPage={maxRows}
      loadPage={loadPage}
      initialPage={1}
      initialRows={initialRows}
      title={title}
      subtitle={subtitle}
      pageLabels={pageLabels}
    />,
  );
}
