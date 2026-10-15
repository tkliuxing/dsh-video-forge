import { configDefaults, defineConfig } from 'vitest/config'

// The live checks spend real money and need real keys; they never run as part
// of `pnpm test` / `pnpm check`, whatever the environment holds. They have
// their own entry: `pnpm test:live` (vitest.live.config.ts).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/live.test.ts'],
  },
})
