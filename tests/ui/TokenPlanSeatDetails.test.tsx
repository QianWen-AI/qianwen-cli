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
import { teamWithSeatDetails } from '../helpers/tokenplan-status.js';

describe('seat details terminal layout', () => {
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
            expect(out).toContain('subs-standard-0123456789abcdef');
            expect(out).toContain('20,000 / 25,000');
            expect(out).toContain(index === 0 ? 'unassigned' : 'Unassigned');
            if (index === 0) {
              expect(out).toContain('SEAT SUMMARY');
              expect(out).toContain('SEAT DETAILS');
              expect(out).toMatch(/SEAT TYPE\s+QUANTITY/);
              expect(out).toMatch(/Standard Seat\s+2/);
              expect(out).toMatch(/Max Seat\s+1/);
              expect(out).toContain('CREDITS (REMAINING / TOTAL)');
            }
            expect(out).not.toContain('…');
            expect(out.split('\n').every((line) => visibleWidth(line) <= columns)).toBe(true);
            expect(out).toContain('─┼─');
            if (columns === 80) expect(out).toMatch(/SEAT ID\s+│\s+subs-standard-0123456789abcdef/);
            else if (index === 0)
              expect(out).toMatch(
                /SEAT ID\s+│\s+SEAT TYPE\s+│\s+STATUS\s+│\s+ASSIGNMENT\s+│\s+CREDITS \(REMAINING \/ TOTAL\)/,
              );
            else
              expect(out).toMatch(/SEAT ID\s+│\s+TYPE\s+│\s+STATUS\s+│\s+ASSIGNMENT\s+│\s+CREDITS/);
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
