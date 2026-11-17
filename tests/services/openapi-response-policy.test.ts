import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockApiClient } from '../helpers/service-mocks.js';
import type { OpenApiPolicyRule } from '../../src/config/openapi-policy.js';

const policy = vi.hoisted(() => ({ current: undefined as OpenApiPolicyRule | undefined }));

vi.mock('../../src/auth/credentials.js', () => ({
  ensureAuthenticated: vi.fn(() => ({ access_token: 'synthetic-openapi-credential' })),
  resolveCredentials: vi.fn(() => ({ access_token: 'synthetic-openapi-credential' })),
}));
vi.mock('../../src/config/openapi-policy.js', () => ({
  findConfiguredOpenApiPolicy: (product: string, action: string) =>
    policy.current?.product === product && policy.current.actions.includes(action)
      ? policy.current
      : undefined,
}));

import { OpenApiService } from '../../src/services/openapi-service.js';

beforeEach(() => {
  vi.clearAllMocks();
  policy.current = {
    product: 'TestPortal',
    actions: ['ReadEntry'],
    auth: 'optional',
    response: 'success-code-envelope',
  };
});

describe('OpenApiService configured response profiles', () => {
  const operation = { product: 'TestPortal', action: 'ReadEntry' };

  it.each(['optional-envelope to required-raw', 'required-raw to optional-envelope'])(
    'keeps the in-flight authentication and response snapshot when policy changes: %s',
    async (transition) => {
      const optionalEnvelope: OpenApiPolicyRule = {
        product: operation.product,
        actions: [operation.action],
        auth: 'optional',
        response: 'success-code-envelope',
      };
      const requiredRaw: OpenApiPolicyRule = {
        product: operation.product,
        actions: [operation.action],
        auth: 'required',
      };
      const startsOptional = transition === 'optional-envelope to required-raw';
      policy.current = startsOptional ? optionalEnvelope : requiredRaw;
      const payload = { preserved: 'request snapshot' };
      const envelope = { Success: true, Data: payload };
      let release!: (value: unknown) => void;
      const response = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      let requests = 0;
      const api = makeMockApiClient({
        flat: async () => (++requests === 1 ? response : envelope),
      });
      const service = new OpenApiService(api);
      const inFlight = service.call(operation);
      await vi.waitFor(() => expect(api.callFlatApi).toHaveBeenCalledTimes(1));
      expect(api.callFlatApi).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ ...operation, authOptional: startsOptional }),
      );

      policy.current = startsOptional ? requiredRaw : optionalEnvelope;
      release(envelope);

      await expect(inFlight).resolves.toBe(startsOptional ? payload : envelope);
      await expect(service.call(operation)).resolves.toBe(startsOptional ? envelope : payload);
      expect(api.callFlatApi).toHaveBeenCalledTimes(2);
      expect(api.callFlatApi).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ ...operation, authOptional: !startsOptional }),
      );
    },
  );

  it('uses the configured status envelope for a generic operation', async () => {
    const payload = { success: false, code: 'INNER_BUSINESS_VALUE', data: ['untouched'] };
    const api = makeMockApiClient({ flat: async () => ({ Success: true, Data: payload }) });

    await expect(new OpenApiService(api).call(operation)).resolves.toBe(payload);

    expect(api.callFlatApi).toHaveBeenCalledExactlyOnceWith({
      ...operation,
      params: undefined,
      signal: undefined,
      authOptional: true,
    });
  });

  it('reports a configured business failure with PascalCase nullish precedence', async () => {
    const api = makeMockApiClient({
      flat: async () => ({
        Success: false,
        success: true,
        Code: 'DENIED',
        code: '200',
        Message: null,
        message: 'synthetic generic failure',
        Data: {},
      }),
    });

    await expect(new OpenApiService(api).call(operation)).rejects.toMatchObject({
      name: 'GatewayBusinessError',
      code: 'DENIED',
      message: 'synthetic generic failure',
    });
  });

  it.each([
    undefined,
    null,
    [],
    'wrong',
    {},
    { Data: {} },
    { Success: true },
    { Success: 'true', Code: 200, Data: {} },
    { Success: true, Code: false, Data: {} },
  ])('rejects malformed configured envelopes: %j', async (envelope) => {
    const api = makeMockApiClient({ flat: async () => envelope });

    await expect(new OpenApiService(api).call(operation)).rejects.toMatchObject({
      code: 'API_RESPONSE_INVALID',
      exitCode: 6,
    });
  });

  it.each([
    { product: 'TestPortal', action: 'OtherEntry' },
    { product: 'OtherPortal', action: 'ReadEntry' },
    { product: 'TestPortal', action: 'readEntry' },
  ])('leaves an unconfigured $product/$action response unchanged', async (request) => {
    const envelope = { Success: false, Code: 'BUSINESS_VALUE', Data: { intact: true } };
    const api = makeMockApiClient({ flat: async () => envelope });

    await expect(new OpenApiService(api).call(request)).resolves.toBe(envelope);
  });
});
