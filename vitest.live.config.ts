import { defineConfig } from 'vitest/config'

// `pnpm test:live` only: the checks against the real vendors (test/live.test.ts).
export default defineConfig({
  test: {
    include: ['test/live.test.ts'],
  },
})
