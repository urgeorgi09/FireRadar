import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Включва всички unit тестове, но изключва integration тестовете
    // (те изискват жива PostgreSQL база и се пускат отделно в CI)
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'node_modules/**'],
  },
})
