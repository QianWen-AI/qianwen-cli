import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderTextDoctor } from '../../../src/output/text/doctor.js';
import { buildDoctorViewModel } from '../../../src/view-models/doctor.js';
import { site } from '../../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

function captureStdout(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderTextDoctor', () => {
  it('renders header, all checks (with status symbols), and footer', () => {
    const vm = buildDoctorViewModel('1.0.0', [
      { name: 'cli_version', status: 'pass', detail: 'v1.0.0 (latest)' },
      { name: 'auth', status: 'pass', detail: 'demo@qianwenai.com' },
      { name: 'token', status: 'warn', detail: 'expires in 3 days' },
      { name: 'network', status: 'pass', detail: 'reachable (12ms)' },
      { name: 'shell_completion', status: 'info', detail: 'not installed' },
    ]);
    const out = captureStdout(() => renderTextDoctor(vm));

    expect(out).toContain(s.doctorTitle);
    expect(out).toContain('v1.0.0');
    expect(out).toContain('CLI version');
    expect(out).toContain('Auth');
    expect(out).toContain('Token');
    expect(out).toContain('Shell completion');

    // Symbols for pass / warn / info
    expect(out).toContain('✓');
    expect(out).toContain('⚠');
    expect(out).toContain('ℹ');

    // Footer summarizes
    expect(out).toMatch(/checks passed|warning|info/);
  });

  it('appends action hint to the detail when check.action is provided', () => {
    const vm = buildDoctorViewModel('1.0.0', [
      {
        name: 'auth',
        status: 'fail',
        detail: 'not authenticated',
        action: `Run: ${s.cliName} login`,
      },
    ]);
    const out = captureStdout(() => renderTextDoctor(vm));
    expect(out).toContain('✗');
    expect(out).toContain('not authenticated');
    expect(out).toContain(`Run: ${s.cliName} login`);
  });

  it('shows "fix auth first" footer when auth check fails', () => {
    const vm = buildDoctorViewModel('1.0.0', [
      { name: 'auth', status: 'fail', detail: 'not authenticated' },
    ]);
    const out = captureStdout(() => renderTextDoctor(vm));
    expect(out.toLowerCase()).toContain('fix auth first');
  });

  it('shows "check your network" footer when network check fails', () => {
    const vm = buildDoctorViewModel('1.0.0', [
      { name: 'cli_version', status: 'pass', detail: 'v1.0.0' },
      { name: 'network', status: 'fail', detail: 'unreachable' },
    ]);
    const out = captureStdout(() => renderTextDoctor(vm));
    expect(out.toLowerCase()).toContain('check your network connection');
  });
});
