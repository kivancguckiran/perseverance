import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      reporter: ['text', 'json-summary'],
    },
    include: ['{agents,apps,packages,services}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.runtime/**'],
  },
})
