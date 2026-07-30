import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The suite mixes CPU-heavy Argon2/PDF work with Git and subprocess
    // fixtures. Capping file workers keeps the default `pnpm verify` gate
    // deterministic on the supported 8-core/16-GiB self-hosted machine.
    maxWorkers: 1,
    coverage: {
      reporter: ['text', 'json-summary'],
    },
    include: [
      '{agents,apps,packages,services}/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/.runtime/**'],
  },
})
