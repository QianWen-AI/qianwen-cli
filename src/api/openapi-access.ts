import { ensureAuthenticated, resolveCredentials } from '../auth/credentials.js';
import { findConfiguredOpenApiPolicy, type OpenApiPolicyRule } from '../config/openapi-policy.js';
import { PUBLIC_ANONYMOUS_CAPABILITIES } from '../types/api-routes.js';
import type { OpenApiCallOptions } from '../types/openapi.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export function isPublicOpenApiOperation(product: string, action: string): boolean {
  const policy = findConfiguredOpenApiPolicy(product, action);
  return policy
    ? policy.auth === 'optional'
    : PUBLIC_ANONYMOUS_CAPABILITIES.get(product)?.has(action) === true;
}

/** API admission belongs to the backend; anonymous access still requires an explicit pair. */
export function assertOpenApiAccess({ product, action, params, signal }: OpenApiCallOptions): {
  authOptional: boolean;
  response?: OpenApiPolicyRule['response'];
} {
  for (const [name, value] of [
    ['product', product],
    ['action', action],
  ]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new CliError({
        code: 'INVALID_ARGUMENT',
        message: `${name} must be a non-empty string.`,
        exitCode: EXIT_CODES.INVALID_ARGUMENT,
      });
    }
  }
  if (
    params !== undefined &&
    (params === null || typeof params !== 'object' || Array.isArray(params))
  ) {
    throw new CliError({
      code: 'INVALID_ARGUMENT',
      message: 'params must be an object.',
      exitCode: EXIT_CODES.INVALID_ARGUMENT,
    });
  }
  signal?.throwIfAborted();
  const policy = findConfiguredOpenApiPolicy(product, action);
  const anonymous = policy
    ? policy.auth === 'optional'
    : PUBLIC_ANONYMOUS_CAPABILITIES.get(product)?.has(action) === true;
  const resolved = resolveCredentials();
  // An expired login must not silently become an anonymous request.
  if (!anonymous || resolved) ensureAuthenticated(resolved);
  return { authOptional: anonymous, response: policy?.response };
}
