import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export interface SiteAvailabilityDeps {
  site: () => string;
  availableSites: Set<string>;
  command: string;
}

export class SiteAvailabilityGuard {
  constructor(private readonly deps: SiteAvailabilityDeps) {}

  assertAvailable(): void {
    const current = this.deps.site();
    if (this.deps.availableSites.has(current)) return;
    const supported = [...this.deps.availableSites];
    const where =
      supported.length === 0
        ? 'no site currently offers a model for it'
        : `it is only available on ${supported.join(', ')}`;
    const hint =
      supported.length === 0
        ? ''
        : ` Run this command with the ${supported[0]} CLI instead (e.g. \`${supported[0]} ${this.deps.command} ...\`).`;

    throw new CliError({
      code: 'INVALID_ARGUMENT',
      message: `${this.deps.command} is not available on ${current} — ${where}.${hint}`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
}
