import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __ERROR_VERBOSITY__: JSON.stringify('verbose'),
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    restoreMocks: true,
    clearMocks: true,
    // Keep subprocess-heavy export tests within the same worker budget as CI.
    maxWorkers: 4,
    // Shared CI runners need more time for transforms and subprocess startup.
    testTimeout: process.env.CI === 'true' || process.env.CI === '1' ? 30_000 : 5_000,
    hookTimeout: process.env.CI === 'true' || process.env.CI === '1' ? 30_000 : 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/index.ts', // re-export barrel
        'src/types/**', // pure type declarations
        'src/mock-data/**', // dev fixtures
        'src/api/mock-client.ts', // dev-only mock implementation
        'src/api/debug-buffer.ts', // diagnostic-only side channel
      ],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
