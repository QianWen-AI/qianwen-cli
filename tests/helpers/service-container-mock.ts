/**
 * Mock ServiceContainer factory for command-layer tests.
 *
 * Returns a "loose" ServiceContainer whose service slots only implement
 * the methods that any individual command test happens to exercise. This
 * keeps each test focused on the one or two services its command actually
 * touches without forcing every test to stub the full DI graph.
 *
 * Tests typically interact with this helper by:
 *
 *   const holder = { services: makeMockServices({
 *     billingService: { getUsageLimit: async () => ({ ... }) },
 *   }) };
 *   vi.mock('../../../src/services/index.js', () => ({
 *     createServices: () => holder.services,
 *   }));
 *
 * The `holder` indirection lets `beforeEach` swap in fresh mocks per test
 * without re-running module top-level mock declarations.
 */
import type { ServiceContainer } from '../../src/services/index.js';

/** Each service slot accepts an arbitrary method bag. */
type LooseService = Record<string, unknown>;

export type PartialServiceContainer = {
  [K in keyof ServiceContainer]?: LooseService;
};

/**
 * Build a ServiceContainer where missing services are still typed but
 * unsafe to call (any method invocation throws). The cast at the boundary
 * is justified: tests only ever exercise services they explicitly stub.
 */
export function makeMockServices(overrides: PartialServiceContainer = {}): ServiceContainer {
  // Plain empty object — accessing an unstubbed method yields `undefined`,
  // which surfaces as `TypeError: services.fooService.bar is not a function`
  // when a test accidentally hits an unmocked code path. We avoid Proxy here
  // because vitest's worker serialization probes object shape eagerly and a
  // get-trap can interfere with module bootstrapping.
  const trap = (_name: string): LooseService => ({});

  const slots: (keyof ServiceContainer)[] = [
    'apiClient',
    'authClient',
    'cache',
    'billingService',
    'freetierService',
    'tokenplanService',
    'modelsService',
    'usageService',
    'authService',
    'docsService',
    'workspaceService',
    'subscriptionService',
    'subscriptionTokenPlanService',
  ];

  const container: Record<string, unknown> = {};
  for (const slot of slots) {
    const override = overrides[slot] as LooseService | undefined;
    container[slot] = override ?? trap(slot);
  }
  return container as ServiceContainer;
}
