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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/index.ts',          // re-export barrel
        'src/types/**',          // pure type declarations
        'src/mock-data/**',      // dev fixtures
        'src/api/mock-client.ts', // dev-only mock implementation
        'src/api/debug-buffer.ts', // diagnostic-only side channel
      ],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
