import type { ApiClient } from '../api/api-client.js';
import { assertOpenApiAccess } from '../api/openapi-access.js';
import { unwrapSuccessCodeEnvelope } from '../api/response-envelope.js';
import type { OpenApiCallOptions } from '../types/openapi.js';
import { CliError } from '../utils/errors.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

function invalidResponse(message: string): CliError {
  return new CliError({
    code: 'API_RESPONSE_INVALID',
    message,
    exitCode: EXIT_CODES.SERVER_ERROR,
  });
}

export class OpenApiService {
  constructor(private readonly apiClient: ApiClient) {}

  async call({ product, action, params, signal }: OpenApiCallOptions): Promise<unknown> {
    const policy = assertOpenApiAccess({ product, action, params, signal });

    const data = await this.apiClient.callFlatApi({
      product,
      action,
      params,
      signal,
      authOptional: policy.authOptional,
    });
    if (data === undefined) {
      throw invalidResponse('OpenAPI response is missing data.');
    }
    if (policy.response === 'success-code-envelope') {
      return unwrapSuccessCodeEnvelope(data, action);
    }
    return data;
  }
}
