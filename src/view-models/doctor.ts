import type { StatusLevel } from '../ui/StatusLine.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { loginCommand } from '../utils/runtime-mode.js';

// ── Doctor ViewModel ──────────────────────────────────────────────────

export interface DoctorViewModel {
  version: string;
  checks: DoctorCheckViewModel[];
  summary: {
    pass: number;
    warn: number;
    info: number;
    fail: number;
  };
  exitCode: number;
  footerMessage: string;
}

export interface DoctorCheckViewModel {
  status: StatusLevel;
  label: string; // "CLI version" / "Auth" / "Token" etc.
  detail: string; // "v1.0.0 (latest)" / "demo@qianwenai.com"
  action?: string; // "Run: qianwen login"
}

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'info' | 'fail';
  detail: string;
  action?: string;
}

const CHECK_LABEL_MAP: Record<string, string> = {
  cli_version: 'CLI version',
  auth: 'Auth',
  token: 'Token',
  network: 'Network',
  shell_completion: 'Shell completion',
  global_config: 'Global config',
};

export function buildDoctorViewModel(version: string, checks: DoctorCheck[]): DoctorViewModel {
  const vmChecks: DoctorCheckViewModel[] = checks.map((check) => ({
    status: check.status,
    label: formatCheckLabel(check.name),
    detail: check.detail,
    action: check.action,
  }));

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    info: checks.filter((c) => c.status === 'info').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };

  const exitCode = computeExitCode(checks);
  const footerMessage = buildFooterMessage(summary, exitCode);

  return {
    version,
    checks: vmChecks,
    summary,
    exitCode,
    footerMessage,
  };
}

/**
 * Map check name to human-readable label.
 * Exported for use by command layer rendering.
 */
export function formatCheckLabel(name: string): string {
  return CHECK_LABEL_MAP[name] || name;
}

/**
 * Compute exit code based on check results (PRD §7.4).
 * Priority: auth/token fail → 2, network fail → 3, other fail → 1, else → 0.
 * Exported for use by command layer.
 */
export function computeExitCode(checks: DoctorCheck[]): number {
  const hasAuthFail = checks.some(
    (c) => (c.name === 'auth' || c.name === 'token') && c.status === 'fail',
  );
  const hasNetworkFail = checks.some((c) => c.name === 'network' && c.status === 'fail');
  const hasOtherFail = checks.some(
    (c) => !['auth', 'token', 'network'].includes(c.name) && c.status === 'fail',
  );

  if (hasAuthFail) return EXIT_CODES.AUTH_FAILURE;
  if (hasNetworkFail) return EXIT_CODES.NETWORK_ERROR;
  if (hasOtherFail) return EXIT_CODES.GENERAL_ERROR;
  return EXIT_CODES.SUCCESS;
}

function buildFooterMessage(
  summary: { pass: number; warn: number; info: number; fail: number },
  exitCode: number,
): string {
  if (summary.fail > 0) {
    if (exitCode === EXIT_CODES.AUTH_FAILURE) return `fix auth first: ${loginCommand()}`;
    if (exitCode === EXIT_CODES.NETWORK_ERROR) return 'check your network connection';
    return 'fix the errors above';
  }

  const parts: string[] = [];
  if (summary.pass > 0) parts.push(`${summary.pass} checks passed`);
  else parts.push('All critical checks passed');

  if (summary.warn > 0) parts.push(`${summary.warn} warning${summary.warn > 1 ? 's' : ''}`);
  if (summary.info > 0) parts.push(`${summary.info} info`);

  return parts.join(' · ');
}
