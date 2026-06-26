import { describe, it, expect } from 'vitest';
import { buildSupportViewViewModel } from '../../../src/view-models/support/view.js';
import type { SupportTicketDetail, SupportMessage } from '../../../src/types/support.js';

const makeDetail = (overrides: Partial<SupportTicketDetail> = {}): SupportTicketDetail => ({
  id: 't-1',
  title: 'Cannot start service',
  status: 'dealing',
  createdAt: new Date(2026, 0, 1, 9, 0).getTime(),
  category: 'Compute / VM',
  description: 'Hello',
  ...overrides,
});

const makeMsg = (overrides: Partial<SupportMessage> = {}): SupportMessage => ({
  role: 'engineer',
  nickName: 'Alice',
  content: 'how can I help',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

describe('buildSupportViewViewModel', () => {
  it('formats ticket fields, mapping status and time', () => {
    const vm = buildSupportViewViewModel(makeDetail(), [], false);
    expect(vm.available).toBe(true);
    expect(vm.ticket.id).toBe('t-1');
    expect(vm.ticket.title).toBe('Cannot start service');
    expect(vm.ticket.status).toBe('Processing');
    expect(vm.ticket.category).toBe('Compute / VM');
    expect(vm.ticket.createdAt).toBe('2026-01-01 09:00');
    expect(vm.messages).toEqual([]);
    expect(vm.messageCount).toBe(0);
    expect(vm.truncated).toBe(false);
  });

  it('strips HTML tags from description and substitutes em-dash when empty', () => {
    const vm1 = buildSupportViewViewModel(
      makeDetail({ description: '<p>Some <b>bold</b> text</p>' }),
      [],
    );
    expect(vm1.ticket.description).toBe('Some bold text');

    const vm2 = buildSupportViewViewModel(makeDetail({ description: '' }), []);
    expect(vm2.ticket.description).toBe('—');
  });

  it('substitutes em-dash for empty title and category', () => {
    const vm = buildSupportViewViewModel(makeDetail({ title: '', category: '' }), []);
    expect(vm.ticket.title).toBe('—');
    expect(vm.ticket.category).toBe('—');
  });

  it('sorts messages ascending by createdAt and strips HTML', () => {
    const t1 = new Date(2026, 0, 1, 10, 0).getTime();
    const t2 = new Date(2026, 0, 1, 11, 0).getTime();
    const t3 = new Date(2026, 0, 1, 12, 0).getTime();
    const vm = buildSupportViewViewModel(makeDetail(), [
      makeMsg({ createdAt: t3, content: '<p>third</p>', role: 'customer' }),
      makeMsg({ createdAt: t1, content: '<div>first</div>', role: 'engineer' }),
      makeMsg({ createdAt: t2, content: 'second', role: 'system' }),
    ]);
    expect(vm.messages).toHaveLength(3);
    expect(vm.messages[0].content).toBe('first');
    expect(vm.messages[0].displayRole).toBe('Support Engineer');
    expect(vm.messages[1].content).toBe('second');
    expect(vm.messages[1].displayRole).toBe('System');
    expect(vm.messages[2].content).toBe('third');
    expect(vm.messages[2].displayRole).toBe('You');
  });

  it('maps role aliases to canonical display roles', () => {
    const base = makeDetail();
    const cases: Array<[string, string]> = [
      ['customer', 'You'],
      ['user', 'You'],
      ['system', 'System'],
      ['robot', 'System'],
      ['engineer', 'Support Engineer'],
      ['SOMETHING_ELSE', 'Support Engineer'],
    ];
    for (const [raw, expected] of cases) {
      const vm = buildSupportViewViewModel(base, [makeMsg({ role: raw })]);
      expect(vm.messages[0].displayRole).toBe(expected);
      expect(vm.messages[0].role).toBe(raw);
    }
  });

  it('respects truncated flag and reports messageCount', () => {
    const vm = buildSupportViewViewModel(
      makeDetail(),
      [makeMsg(), makeMsg({ createdAt: 1_700_000_001_000 })],
      true,
    );
    expect(vm.truncated).toBe(true);
    expect(vm.messageCount).toBe(2);
  });

  it('handles null/undefined messages safely', () => {
    const vm = buildSupportViewViewModel(
      makeDetail(),
      // simulate API returning no messages array
      [],
    );
    expect(vm.messages).toEqual([]);
    expect(vm.messageCount).toBe(0);
  });
});
