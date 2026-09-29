import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'api/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
