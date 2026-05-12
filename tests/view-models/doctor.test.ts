import { describe, it, expect } from 'vitest';
import { buildDoctorViewModel } from '../../src/view-models/doctor.js';
import type { DoctorCheck } from '../../src/view-models/doctor.js';
import { site } from '../../src/site.js';

const s = { ...site, ...site.features, currencySymbol: site.features.currency === 'CNY' ? '¥' : '$' };

describe('buildDoctorViewModel', () => {
  const baseChecks: DoctorCheck[] = [
    { name: 'cli_version', status: 'pass', detail: 'v1.0.0 (latest)' },
    { name: 'auth', status: 'pass', detail: 'demo@qianwenai.com' },
    { name: 'token', status: 'pass', detail: 'expires in 23h 45m' },
    { name: 'network', status: 'pass', detail: 'latency 42ms' },
    { name: 'shell_completion', status: 'warn', detail: 'not installed', action: `${s.cliName} completion install` },
    { name: 'global_config', status: 'pass', detail: `~/${s.configDirName}/config.json` },
    { name: 'project_config', status: 'info', detail: 'not found, using global defaults' },
  ];

  it('builds view model with all checks', () => {
    const vm = buildDoctorViewModel('1.0.0', baseChecks);

    expect(vm.version).toBe('1.0.0');
    expect(vm.checks).toHaveLength(7);
    expect(vm.summary).toEqual({ pass: 5, warn: 1, info: 1, fail: 0 });
    expect(vm.exitCode).toBe(0);

    // Check labels are formatted
    expect(vm.checks[0].label).toBe('CLI version');
    expect(vm.checks[1].label).toBe('Auth');
    expect(vm.checks[3].label).toBe('Network');
  });

  it('computes exit code 2 for auth failure', () => {
    const checks: DoctorCheck[] = [
      ...baseChecks,
      { name: 'auth', status: 'fail', detail: 'Not authenticated', action: `${s.cliName} login` },
    ];
    // Override auth to fail (replace the pass one)
    const allChecks = checks.filter((c, i, arr) => i < 5 || c.name !== 'auth' || c.status === 'fail');
    allChecks[1] = { name: 'auth', status: 'fail', detail: 'Not authenticated', action: `${s.cliName} login` };

    const vm = buildDoctorViewModel('1.0.0', allChecks);
    expect(vm.exitCode).toBe(2);
    expect(vm.footerMessage).toContain('auth');
  });

  it('computes exit code 3 for network failure', () => {
    const checks = [...baseChecks];
    checks[3] = { name: 'network', status: 'fail', detail: 'unreachable', action: 'Check network' };

    const vm = buildDoctorViewModel('1.0.0', checks);
    expect(vm.exitCode).toBe(3);
  });

  it('computes exit code 1 for other failures', () => {
    const checks = [...baseChecks];
    checks.push({ name: 'some_check', status: 'fail', detail: 'error' });

    const vm = buildDoctorViewModel('1.0.0', checks);
    expect(vm.exitCode).toBe(1);
  });

  it('builds footer message for all pass', () => {
    const vm = buildDoctorViewModel('1.0.0', baseChecks);
    expect(vm.footerMessage).toContain('passed');
    expect(vm.footerMessage).toContain('warning');
  });

  it('handles unknown check names', () => {
    const checks: DoctorCheck[] = [
      { name: 'unknown_check', status: 'pass', detail: 'some detail' },
    ];
    const vm = buildDoctorViewModel('1.0.0', checks);
    expect(vm.checks[0].label).toBe('unknown_check');
  });
});
