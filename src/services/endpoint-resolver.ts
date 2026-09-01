/** Endpoint resolution for model-inference calls. */

import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import { site } from '../site.js';

export const ENDPOINT_ENV_NAME = `${site.envPrefix}_ENDPOINT`;

/** Short names accepted in place of a full URL. */
const PRESET_ENDPOINTS: Record<string, string> = {
  [site.dashscopeEndpointName]: site.dashscopeEndpoint,
};

export interface EndpointResolverDeps {
  readEnv: (name: string) => string | undefined;
  readConfig: (key: 'model.endpoint') => string | undefined;
}

function firstNonBlank(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Token-plan keys (sk-sp-*) authenticate only on the token-plan gateway. */
export function isTokenPlanToken(token: string | undefined): boolean {
  return typeof token === 'string' && token.startsWith('sk-sp-');
}

export class EndpointResolver {
  constructor(private readonly deps: EndpointResolverDeps) {}

  resolve(endpointFlag?: string, token?: string): string {
    const candidate =
      firstNonBlank(endpointFlag) ??
      firstNonBlank(this.deps.readEnv(ENDPOINT_ENV_NAME)) ??
      firstNonBlank(this.deps.readConfig('model.endpoint'));

    if (candidate === undefined) {
      return isTokenPlanToken(token) ? site.tokenPlanEndpoint : site.dashscopeEndpoint;
    }

    const preset = PRESET_ENDPOINTS[candidate];
    if (preset) return preset;

    if (isHttpUrl(candidate)) return candidate.replace(/\/+$/, '');

    const presetNames = Object.keys(PRESET_ENDPOINTS).join(', ');
    throw new CliError({
      code: 'INVALID_ENDPOINT',
      message: `Invalid endpoint: ${candidate}. Expected a full http(s) URL or one of: ${presetNames}.`,
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
}
