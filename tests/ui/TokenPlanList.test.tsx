import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { TokenPlanListInk, renderTokenPlanListInk } from '../../src/ui/TokenPlanList.js';
import * as inkRenderer from '../../src/ui/render.js';
import { TokenPlanDetailTables } from '../../src/ui/TokenPlanDetailTables.js';
import { buildTokenPlanListViewModel } from '../../src/view-models/subscription/tokenplan-list.js';
import { stripAnsi, visibleWidth } from '../../src/ui/textWrap.js';
import { renderTextTokenPlanList } from '../../src/output/text/tokenplan-list.js';
import type { TokenPlanListResult } from '../../src/types/tokenplan-catalog.js';

const terminal = vi.hoisted(() => ({ columns: 60, rows: 25 }));

vi.mock('../../src/ui/useTerminalSize.js', () => ({
  useTerminalSize: () => terminal,
}));

describe('Token Plan static tables', () => {
  it.each([60, 120])(
    'keeps one blank line before copyable guidance after a %s-column table',
    async (columns) => {
      terminal.columns = columns;
      const vm = buildTokenPlanListViewModel({
        authenticated: true,
        edition: 'all',
        billingCycle: 'monthly',
        completeness: 'complete',
        sections: [],
      });
      const renderer = vi.spyOn(inkRenderer, 'renderWithInk');
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await renderTokenPlanListInk(vm);
        expect(renderer).toHaveBeenCalledWith(expect.anything(), { trailingNewline: false });
        const output = stripAnsi(stdout.mock.calls.map(([chunk]) => String(chunk)).join(''));
        expect(output).toContain('TOKEN PLAN CATALOG');
        expect(output).toContain(`BILLING CYCLE ${vm.billingCycleLabel}\n\n${vm.note}`);
        expect(output).not.toContain('\n\n\n');
        expect(
          output
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('qianwen subscription tokenplan purchase ')),
        ).toEqual([
          'qianwen subscription tokenplan purchase <individual-token-plan-type> --channel alipay --billing-cycle <cycle> --no-auto-renew',
          'qianwen subscription tokenplan purchase token_plan_team --channel alipay --billing-cycle <cycle> --standard-seat-count <n> --no-auto-renew',
        ]);
        expect(output).not.toContain('<token-plan-type>');
        expect(output).not.toContain('\\\n');
      } finally {
        renderer.mockRestore();
        stdout.mockRestore();
        terminal.columns = 60;
      }
    },
  );

  it.each([60, 120, 139])(
    'uses section rules with left-aligned content at %s columns',
    (columns) => {
      terminal.columns = columns;
      const result: TokenPlanListResult = {
        authenticated: true,
        edition: 'all',
        billingCycle: 'monthly',
        completeness: 'complete',
        sections: (['individual', 'team'] as const).map((edition) => ({
          edition,
          billingCycleSupported: true,
          subscriptionStatus: 'not_subscribed',
          currentPlan: null,
          currentBillingCycle: null,
          subscriptionUrl: null,
          diagnostics: [],
          rows: [
            {
              type: edition === 'individual' ? 'token_plan_individual_pro' : 'token_plan_team',
              specCode: edition === 'individual' ? 'pro' : 'standard',
              seatType: edition === 'individual' ? null : 'standard',
              name: edition === 'individual' ? 'Pro' : 'Standard Seat',
              price: '80',
              currency: 'CNY',
              inventory: true,
              monthlyCredits: '1000',
              status: 'purchasable',
            },
          ],
          plans: [
            {
              ...(edition === 'individual' ? { tier: 'pro' } : { seatType: 'standard' }),
              billingTerm: 'monthly',
              listPrice: '100',
              promoPrice: '80',
              currency: 'CNY',
              quotaWindows: [{ windowType: 'monthly', totalCredits: '1000' }],
              supportedModels: [
                {
                  modelId: `qwen-${edition}-full-model-id-reasoning-enhanced`,
                  modelBrand: 'Qwen',
                  modelName:
                    edition === 'individual'
                      ? '个人版完整模型名称千问推理增强版本'
                      : '团队版完整模型名称千问推理增强版本',
                  capabilities: ['TG', 'Reasoning'],
                  isNew: true,
                  badgeLabel: '限时2折',
                  badgeDescription: 'Tooltip-only promotion description',
                },
              ],
            },
          ],
        })),
      };
      const before = structuredClone(result);
      const vm = buildTokenPlanListViewModel(result);
      const screen = render(
        <Box width={columns}>
          <TokenPlanListInk vm={vm} />
        </Box>,
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        renderTextTokenPlanList(vm);
        const table = stripAnsi(screen.lastFrame() ?? '');
        const text = log.mock.calls.flat().join('\n');
        for (const output of [table, text]) {
          const titles = [
            'INDIVIDUAL TOKEN PLANS',
            'CURRENT SUBSCRIPTION',
            'PRICING',
            'SUPPORTED MODELS',
            'TEAM TOKEN PLANS',
          ];
          const positions = titles.map((title) => output.indexOf(title));
          expect(positions.every((position) => position >= 0)).toBe(true);
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
          expect(output).not.toContain('HARNESS');
          expect(output).toContain('Status');
          expect(output).toContain('purchasable');
          const lines = output.split('\n');
          expect(lines.find((line) => line.includes('TOKEN PLAN CATALOG'))).toMatch(
            /^TOKEN PLAN CATALOG═+$/,
          );
          expect(lines.find((line) => line.includes('INDIVIDUAL TOKEN PLANS'))).toMatch(
            /^INDIVIDUAL TOKEN PLANS─+$/,
          );
          expect(lines.find((line) => line.includes('TEAM TOKEN PLANS'))).toMatch(
            /^TEAM TOKEN PLANS─+$/,
          );
          for (const line of lines.filter((line) =>
            /^(INDIVIDUAL|TEAM) TOKEN PLANS─+$/.test(line.trim()),
          ))
            expect(line).toMatch(/^\S/);
          for (const [index, line] of lines.entries()) {
            if (
              ![
                'CURRENT SUBSCRIPTION',
                'PRICING',
                'SUPPORTED MODELS',
                'HARNESS ALLOWANCES',
              ].includes(line.trim())
            )
              continue;
            expect(line).toBe(line.trim());
            expect(lines.slice(index + 1).find((value) => value.trim())).toMatch(/^\S/);
          }
          const team = output.slice(output.indexOf('TEAM TOKEN PLANS'));
          expect(team).toContain('SUPPORTED MODELS');
          expect(team).not.toContain('HARNESS ALLOWANCES');
          expect(team).not.toContain('个人版完整模型名称');
          expect(output).toContain('qwen-individual-full-model-id-reasoning-enhanced');
          expect(output).toContain('qwen-team-full-model-id-reasoning-enhanced');
          expect(output).not.toContain('完整模型名称千问推理增强版本');
          expect(output).toContain('文本生成、推理模型');
          expect(output).toContain('TAG');
          expect(output).toContain('New、限时2折');
          expect(output).not.toContain('Tooltip-only promotion description');
          expect(output).not.toContain('…');
        }
        expect(table.split('\n').every((line) => visibleWidth(line) <= columns)).toBe(true);
        expect(text).not.toMatch(/\x1b/);
        expect(vm.data).toEqual(before);
        expect(result).toEqual(before);
      } finally {
        log.mockRestore();
        screen.unmount();
        terminal.columns = 60;
      }
    },
  );

  it.each([66, 67, 70])(
    'uses the full %s-column terminal before falling back to model records',
    (columns) => {
      terminal.columns = columns;
      const modelName = '千问'.repeat(7);
      const modelId = 'qwen-model-'.padEnd(31, 'x');
      const source: TokenPlanListResult = {
        authenticated: false,
        edition: 'individual',
        billingCycle: 'monthly',
        completeness: 'complete',
        sections: [
          {
            edition: 'individual',
            billingCycleSupported: true,
            subscriptionStatus: 'not_subscribed',
            currentPlan: null,
            currentBillingCycle: null,
            subscriptionUrl: null,
            diagnostics: [],
            rows: [],
            plans: [
              {
                tier: 'lite',
                billingTerm: 'monthly',
                listPrice: '60',
                promoPrice: null,
                currency: 'CNY',
                quotaWindows: [],
                supportedModels: [{ modelId, modelBrand: 'Qwen', modelName, capabilities: ['TG'] }],
              },
            ],
          },
        ],
      };
      const before = structuredClone(source);
      const vm = buildTokenPlanListViewModel(source);
      const screen = render(
        <Box width={columns}>
          <TokenPlanListInk vm={vm} />
        </Box>,
      );
      try {
        const output = stripAnsi(screen.lastFrame() ?? '');
        const models = output.slice(output.indexOf('SUPPORTED MODELS'));
        expect(models).toContain(modelId);
        expect(models).not.toContain(modelName);
        if (columns >= 67) {
          expect(models).toContain('│');
          expect(models).not.toContain('MODEL NAME:');
          expect(models).not.toContain('Note: Widen the terminal');
        } else {
          expect(models).toContain(`MODEL NAME: ${modelId}`);
          expect(models).toContain('Note: Widen the terminal to view this section as a table.');
        }
        expect(output.split('\n').every((line) => visibleWidth(line) <= columns)).toBe(true);
        expect(output).not.toContain('…');
        expect(vm.data).toEqual(before);
        expect(source).toEqual(before);
      } finally {
        screen.unmount();
        terminal.columns = 60;
      }
    },
  );
  it.each([60, 120])('renders every legacy Individual status label at %s columns', (columns) => {
    terminal.columns = columns;
    const statuses = ['unavailable', 'subscribed', 'upgrade', 'purchasable', 'unknown'] as const;
    const source: TokenPlanListResult = {
      authenticated: true,
      edition: 'individual',
      billingCycle: 'monthly',
      completeness: 'complete',
      sections: [
        {
          edition: 'individual',
          billingCycleSupported: true,
          subscriptionStatus: 'active',
          currentPlan: 'essential',
          currentBillingCycle: 'monthly',
          subscriptionUrl: null,
          diagnostics: [],
          rows: statuses.map((status, index) => ({
            type: 'fixture',
            specCode: ['lite', 'essential', 'standard', 'pro', 'future'][index]!,
            seatType: null,
            name: 'fixture',
            price: '80',
            currency: 'CNY',
            inventory: true,
            weeklyCredits: 1000,
            monthlyCredits: null,
            status,
          })),
        },
      ],
    };
    const before = structuredClone(source);
    const vm = buildTokenPlanListViewModel(source);
    const screen = render(
      <Box width={columns}>
        <TokenPlanListInk vm={vm} />
      </Box>,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      renderTextTokenPlanList(vm);
      const table = stripAnsi(screen.lastFrame() ?? '');
      for (const output of [table, log.mock.calls.flat().join('\n')]) {
        expect(output).toContain('Status');
        for (const label of [
          'not_subscribable',
          'current_plan',
          'upgrade_on_web',
          'purchasable',
          'unknown',
        ])
          expect(output).toContain(label);
        expect(output).not.toContain('…');
      }
      expect(table.split('\n').every((line) => visibleWidth(line) <= columns)).toBe(true);
      expect(vm.data).toEqual(before);
      expect(source).toEqual(before);
    } finally {
      screen.unmount();
      log.mockRestore();
      terminal.columns = 60;
    }
  });
  it.each(
    [60, 120].flatMap((columns) =>
      [null, '', 'fixture-team-subscription'].map((subscriptionId) => ({
        columns,
        subscriptionId,
      })),
    ),
  )(
    'shows Team identity without quota details at $columns columns ($subscriptionId)',
    ({ columns, subscriptionId }) => {
      terminal.columns = columns;
      const source: TokenPlanListResult = {
        authenticated: true,
        edition: 'team',
        billingCycle: 'monthly',
        completeness: 'complete',
        sections: [
          {
            edition: 'team',
            billingCycleSupported: true,
            subscriptionStatus: 'active',
            currentPlan: null,
            currentBillingCycle: null,
            subscriptionUrl: null,
            rows: [],
            diagnostics: [],
            currentPlanDetails: {
              subscriptionId,
              endAt: '2027-01-01T00:00:00.000Z',
              totalCredits: '1000',
              remainingCredits: '0',
            },
          },
        ],
      };
      const before = structuredClone(source);
      const vm = buildTokenPlanListViewModel(source);
      const screen = render(
        <Box width={columns}>
          <TokenPlanListInk vm={vm} />
        </Box>,
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        renderTextTokenPlanList(vm);
        for (const output of [
          stripAnsi(screen.lastFrame() ?? ''),
          log.mock.calls.flat().join('\n'),
        ]) {
          if (subscriptionId) expect(output).toContain(`Subscription ID: ${subscriptionId}`);
          else expect(output).not.toContain('Subscription ID');
          expect(output).not.toMatch(
            /Total Credits:|Remaining Credits:|Used \(%\)|Remaining \(%\)/,
          );
          expect(output).toContain('Asia/Shanghai');
        }
        expect(vm.data.sections[0]?.currentPlanDetails).toEqual({
          subscriptionId,
          endAt: '2027-01-01T00:00:00.000Z',
        });
        expect(source).toEqual(before);
      } finally {
        log.mockRestore();
        screen.unmount();
        terminal.columns = 60;
      }
    },
  );
  it('renders complete matrix values as tier lines when a narrow table would truncate them', () => {
    const screen = render(
      <Box width={60}>
        <TokenPlanDetailTables
          tables={[
            {
              title: 'HARNESS ALLOWANCES',
              layout: 'matrix',
              headers: ['TOOL', 'lite', 'pro'],
              rows: [
                [
                  '联网搜索增强版 MCP',
                  '5 次; Discount unknown',
                  '500 次/月; Discount 0.88 (ratio)',
                ],
              ],
              emptyMessage: 'No data',
              note: 'Unknown: unconfirmed. —: no allowance listed.',
            },
          ]}
        />
      </Box>,
    );
    try {
      const output = stripAnsi(screen.lastFrame() ?? '');
      expect(output).toContain('联网搜索增强版 MCP');
      expect(output).toContain('lite: 5 次; Discount unknown');
      expect(output).toContain('pro: 500 次/月; Discount 0.88 (ratio)');
      expect(output.split('\n').every((line) => visibleWidth(line) <= 60)).toBe(true);
    } finally {
      screen.unmount();
    }
  });

  it.each([60, 120])('shows personal percentage details at %s columns', (columns) => {
    terminal.columns = columns;
    const vm = buildTokenPlanListViewModel({
      authenticated: true,
      edition: 'individual',
      billingCycle: 'monthly',
      completeness: 'complete',
      sections: [
        {
          edition: 'individual',
          billingCycleSupported: true,
          subscriptionStatus: 'active',
          currentPlan: 'lite',
          currentBillingCycle: 'monthly',
          subscriptionUrl: 'https://platform.test.qianwenai.com/subscription/fixture',
          rows: [],
          diagnostics: [],
          currentPlanDetails: {
            subscriptionId: 'fixture-subscription-with-a-long-identifier-for-width-testing',
            endAt: '2027-01-01T00:00:00.000Z',
            totalCredits: '1000',
            remainingCredits: null,
            remainingPct: 0,
            quotaWindowType: 'monthly',
          },
          plans: [],
        },
      ],
    });
    const screen = render(
      <Box width={columns}>
        <TokenPlanListInk vm={vm} />
      </Box>,
    );
    try {
      const output = stripAnsi(screen.lastFrame() ?? '');
      expect(output).toContain('TOKEN PLAN CATALOG');
      expect(output).toContain('Subscription ID:');
      expect(output).toContain('Asia/Shanghai');
      expect(output.replace(/\s+/g, ' ')).toContain('Used (%): 100%; Remaining (%): 0% (monthly)');
      expect(output).not.toMatch(/Total Credits:|Remaining Credits/);
      expect(output.split('\n').every((line) => visibleWidth(line) <= columns)).toBe(true);
    } finally {
      screen.unmount();
      terminal.columns = 60;
    }
  });

  it('renders real zero and explicit empty messages in the shared detail component', () => {
    const screen = render(
      <TokenPlanDetailTables
        showNarrowLayoutHint
        tables={[
          {
            title: 'HARNESS',
            headers: ['TOOL', 'TOTAL', 'REMAINING'],
            rows: [['Tool', '0', '0']],
            emptyMessage: 'unavailable',
          },
          {
            title: 'MODELS',
            headers: ['MODEL'],
            rows: [],
            emptyMessage: 'No supported models available.',
          },
        ]}
      />,
    );
    try {
      const output = stripAnsi(screen.lastFrame() ?? '');
      expect(output).toContain('HARNESS');
      expect(output).toMatch(/Tool\s+│\s+0\s+│\s+0/);
      expect(output).toContain('No supported models available.');
      expect(output).not.toContain('Note: Widen the terminal');
    } finally {
      screen.unmount();
    }
  });
});
