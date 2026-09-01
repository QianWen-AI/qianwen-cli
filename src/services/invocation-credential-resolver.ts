/** Credential resolution for model-inference calls. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { site } from '../site.js';
import type { CredentialSource, ResolvedInvocationCredential } from '../types/model-invocation.js';

export const API_KEY_ENV_NAME = `${site.envPrefix}_API_KEY`;
export const GENERIC_API_KEY_ENV_NAME = 'DASHSCOPE_API_KEY';

export interface CredentialResolverDeps {
  resolveOAuth: () => { access_token: string } | null;
  readEnv: (name: string) => string | undefined;
  readConfig: (key: 'model.api_key') => string | undefined;
}

function firstNonBlank(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class InvocationCredentialResolver {
  constructor(private readonly deps: CredentialResolverDeps) {}

  resolve(apiKeyFlag?: string): ResolvedInvocationCredential {
    const envNames = [API_KEY_ENV_NAME, ...site.apiKeyEnvAliases, GENERIC_API_KEY_ENV_NAME];

    const tiers: Array<[CredentialSource, () => string | undefined]> = [
      ['flag', () => firstNonBlank(apiKeyFlag)],
      [
        'env',
        () => {
          for (const name of envNames) {
            const value = firstNonBlank(this.deps.readEnv(name));
            if (value) return value;
          }
          return undefined;
        },
      ],
      ['oauth', () => firstNonBlank(this.deps.resolveOAuth()?.access_token)],
      ['config', () => firstNonBlank(this.deps.readConfig('model.api_key'))],
    ];

    for (const [source, read] of tiers) {
      const token = read();
      if (token) return { token, source };
    }

    const envList = envNames.join(' / ');
    throw new CliError({
      code: 'AUTH_REQUIRED',
      message: `Missing API key. Set ${envList}, or pass --api-key. Create one at ${site.apiKeyConsoleUrl} (shown once).`,
      exitCode: EXIT_CODES.AUTH_FAILURE,
    });
  }
}
