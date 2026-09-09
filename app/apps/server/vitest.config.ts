import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Seeds the Polar webhook secret + product ids before any module imports
    // config. Does NOT enable billing (no access token) — see the file's note.
    setupFiles: ["tests/helpers/billing-env.ts", "tests/helpers/email-env.ts"],
    // Integration tests share one Postgres; run serially to keep state predictable.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globals: false,
  },
});
