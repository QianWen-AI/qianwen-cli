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
 * Build a ServiceContainer holding only the services a test explicitly stubs.
 *
 * There is deliberately no slot list. An earlier version enumerated every
 * `ServiceContainer` key by hand, and `yunqiService` was silently omitted when
 * the yunqi feature landed — so `makeMockServices({ yunqiService })` dropped
 * the override and handed back `undefined`. A list that must be kept in sync
 * with the interface will drift, and a type-level exhaustiveness guard cannot
 * catch it here because tsconfig excludes `tests/`, so `tsc --noEmit` never
 * checks this file. Deriving the container from the overrides leaves nothing
 * to keep in sync.
 *
 * An unstubbed service is therefore absent, and reaching it fails immediately
 * with a TypeError naming the service — the same loud failure the previous
 * `{}` placeholder produced, without the bookkeeping.
 */
export function makeMockServices(overrides: PartialServiceContainer = {}): ServiceContainer {
  // The cast at the boundary is justified: tests only ever exercise services
  // they explicitly stub, and hitting any other one must throw.
  return { ...overrides } as unknown as ServiceContainer;
}
