import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    // Each file creates its own migrated database; concurrency tests also hold
    // row locks, so give slow CI runners room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
