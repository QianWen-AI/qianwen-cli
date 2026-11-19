import React from 'react';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import stripAnsi from 'strip-ansi';
import { SubscriptionTokenPlanStatusInk } from '../../src/ui/SubscriptionTokenPlanStatus.js';
import { SubscriptionStatusInk } from '../../src/ui/SubscriptionStatus.js';
import { buildTokenPlanStatusViewModel } from '../../src/view-models/subscription/tokenplan-status.js';
import { buildSubscriptionStatusViewModel } from '../../src/view-models/subscription/status.js';
import { visibleWidth } from '../../src/ui/textWrap.js';
import { teamWithSeatDetails, tokenPlanStatusWithDetails } from '../helpers/tokenplan-status.js';

describe('seat details terminal layout', () => {
  it.each([40, 60, 103, 120, 362])(
    'keeps every Individual field and Harness ratio in the aggregate status at %s columns',
    async (columns) => {
      const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
      Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
      const stdout = new PassThrough();
      Object.defineProperty(stdout, 'columns', { value: columns });
      let frame = '';
      stdout.on('data', (chunk: Buffer) => {
        frame = chunk.toString();
      });
      const source = tokenPlanStatusWithDetails();
      const vm = buildSubscriptionStatusViewModel(
        {
          individual: source.individual,
          team: source.team,
          isGray: false,
          plan: null,
          period: null,
          quota: null,
          autoRenew: null,
          renewable: null,
          remainingDays: null,
          seatTiers: [],
          creditPacks: [],
          recentOrders: [],
        },
        [],
      );
      const instance = render(<SubscriptionStatusInk vm={vm} />, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const output = stripAnsi(frame);
        const personal = output.slice(output.indexOf('Individual'), output.indexOf('Team'));
        expect(personal).toContain('INDIVIDUAL CREDIT WINDOWS');
        expect(personal).toContain('PERSONAL HARNESS ALLOWANCES');
        expect(personal).toContain('REMAINING (%)');
        expect(personal).not.toContain('TOTAL CREDITS');
        expect(personal).not.toContain('REMAINING CREDITS');
        expect(personal.match(/90%/g)).toHaveLength(7);
        for (const tool of source.individual!.harnessAllowances!)
          expect(personal).toContain(tool.toolName);
        expect(output.split('\n').every((line) => visibleWidth(line) <= columns)).toBe(true);
        expect(personal).not.toContain('…');
        expect(output).toContain('Team');
        expect(output).toContain('Seat Details');
      } finally {
        instance.unmount();
        stdout.destroy();
        if (original) Object.defineProperty(process.stdout, 'columns', original);
        else Reflect.deleteProperty(process.stdout, 'columns');
      }
    },
  );
  it.each([40, 60, 103, 117, 120, 362])(
    'groups status details and aligns every table at %s columns',
    async (columns) => {
      const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
      Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
      const stdout = new PassThrough();
      Object.defineProperty(stdout, 'columns', { value: columns });
      let frame = '';
      stdout.on('data', (chunk: Buffer) => {
        frame = chunk.toString();
      });
      const source = tokenPlanStatusWithDetails();
      const instance = render(
        <SubscriptionTokenPlanStatusInk vm={buildTokenPlanStatusViewModel(source, 'tui')} />,
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          debug: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const output = stripAnsi(frame);
        const titles = [
          'Individual',
          'INDIVIDUAL CREDIT WINDOWS',
          'PERSONAL HARNESS ALLOWANCES',
          'Team',
          'TEAM CREDIT SUMMARY',
        ];
        const positions = titles.map((title) => output.indexOf(title));
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(output).not.toContain('SEAT SUMMARY');
        expect(output).not.toContain('SEAT DETAILS');
        expect(output).not.toMatch(/^\s*Name\s/m);
        expect(output.slice(output.indexOf('Team'))).not.toContain('Subscription ID');
        const normalized = output.replace(/\s+/g, ' ');
        expect(normalized).toContain(
          'The total credits is the sum of the credits of all seats of the same seat type.',
        );
        expect(normalized).toContain('Only active seats are shown.');
        expect(normalized).toContain('qianwen subscription tokenplan seats');
        for (const tool of source.individual!.harnessAllowances!)
          expect(output).toContain(tool.toolName);
        const harness = output.slice(
          output.indexOf('PERSONAL HARNESS ALLOWANCES'),
          output.indexOf('Team'),
        );
        expect(harness).toContain('REMAINING (%)');
        expect(harness.match(/90%/g)).toHaveLength(source.individual!.harnessAllowances!.length);
        const individualCredits = output.slice(
          output.indexOf('INDIVIDUAL CREDIT WINDOWS'),
          output.indexOf('PERSONAL HARNESS ALLOWANCES'),
        );
        expect(individualCredits).not.toContain('REMAINING CREDITS');
        expect(individualCredits).not.toContain('TOTAL CREDITS');
        expect(individualCredits).toContain('USED (%)');
        expect(output.slice(output.indexOf('TEAM CREDIT SUMMARY'))).toContain('REMAINING CREDITS');
        expect(output.split('\n').every((line) => visibleWidth(line) <= columns)).toBe(true);
        for (const title of titles.filter((title) => title === title.toUpperCase())) {
          const lines = output.split('\n');
          const index = lines.findIndex((line) => line.trim() === title);
          expect(lines[index]).toBe(`    ${title}`);
          const header = lines.slice(index + 1).find((line) => line.trim());
          expect(header).toMatch(/^ {4}\S/);
          expect(lines[index + 1]).toMatch(/^ {4}\S/);
        }
        const teamCredits = output.slice(output.indexOf('TEAM CREDIT SUMMARY'));
        expect(teamCredits).toContain('REMAINING (%)');
        expect(teamCredits).toContain('80%');
        expect(output).not.toMatch(/(?:Standard|Max) Seat/);
        expect(output).not.toContain('…');
      } finally {
        instance.unmount();
        stdout.destroy();
        if (original) Object.defineProperty(process.stdout, 'columns', original);
        else Reflect.deleteProperty(process.stdout, 'columns');
      }
    },
  );
  it.each([80, 120])(
    'renders both status pages without truncation at %s columns',
    async (columns) => {
      const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
      Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
      const team = teamWithSeatDetails();
      const dedicated = buildTokenPlanStatusViewModel(
        {
          team,
          product: 'Token Plan',
          period: null,
          autoRenew: null,
          renewable: null,
          seatSummary: team.seatSummary,
          diagnostics: [],
        },
        'tui',
      );
      const general = buildSubscriptionStatusViewModel(
        {
          team,
          isGray: false,
          plan: null,
          period: null,
          quota: null,
          autoRenew: null,
          renewable: null,
          remainingDays: null,
          seatTiers: [],
          creditPacks: [],
          recentOrders: [],
        },
        [],
      );
      try {
        for (const [index, element] of [
          <SubscriptionTokenPlanStatusInk vm={dedicated} />,
          <SubscriptionStatusInk vm={general} />,
        ].entries()) {
          const stdout = new PassThrough();
          Object.defineProperty(stdout, 'columns', { value: columns });
          let frame = '';
          stdout.on('data', (chunk: Buffer) => {
            frame = chunk.toString();
          });
          const instance = render(element, {
            stdout: stdout as unknown as NodeJS.WriteStream,
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
          });
          try {
            await new Promise((resolve) => setImmediate(resolve));
            const out = stripAnsi(frame);
            expect(out).toContain('3 total · 2 assigned · 1 unassigned');
            if (index === 0) {
              expect(out).not.toContain('SEAT SUMMARY');
              expect(out).not.toContain('SEAT DETAILS');
              expect(out).not.toContain('subs-standard-0123456789abcdef');
              expect(out).not.toContain('20,000 / 25,000');
            } else {
              expect(out).toContain('subs-standard-0123456789abcdef');
              expect(out).toContain('20,000 / 25,000');
              expect(out).toContain('Unassigned');
            }
            expect(out).not.toContain('…');
            expect(out.split('\n').every((line) => visibleWidth(line) <= columns)).toBe(true);
            if (index === 1) {
              expect(out).toContain('─┼─');
              if (columns === 80)
                expect(out).toMatch(/SEAT ID\s+│\s+subs-standard-0123456789abcdef/);
              else
                expect(out).toMatch(
                  /SEAT ID\s+│\s+TYPE\s+│\s+STATUS\s+│\s+ASSIGNMENT\s+│\s+CREDITS/,
                );
            }
          } finally {
            instance.unmount();
            stdout.destroy();
          }
        }
      } finally {
        if (original) Object.defineProperty(process.stdout, 'columns', original);
        else Reflect.deleteProperty(process.stdout, 'columns');
      }
    },
  );
});
