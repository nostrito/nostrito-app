import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    // Run relay integration tests sequentially to avoid race conditions
    sequence: { concurrent: false },
    // Retry flaky relay tests up to 2 times
    retry: 1,
  },
});
