import { defineConfig } from 'vitest/config';

/**
 * Test runner (audit #27). Standard vitest setup for this Vite repo:
 * picks up `*.test.{ts,tsx}` under src/ (so the sibling workers' tests
 * for dedupCallHistory and the storage key parsing run here too), node
 * environment — pure-helper tests need nothing else. Tests that import
 * screens/components (React, AWS, Capacitor) should set their own
 * environment per file (`// @vitest-environment jsdom`) and mock the
 * `aws` layer; see the callHistoryGroups smoke test for the pattern
 * that needs no mocks at all.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
