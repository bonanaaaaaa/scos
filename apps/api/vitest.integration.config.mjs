import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    // The Worker's integration tests run in workerd (vitest.workers.integration.config.mjs).
    exclude: [...configDefaults.exclude, "test/workers/**"],
    // Each file creates its own migrated database; concurrency tests also hold
    // row locks, so give slow CI runners room.
    //
    // These are the developer-owned full-stack tests, which compose the
    // application in this process. The QA acceptance suite, which only ever
    // reaches the API through its built artifact and HTTP, lives in
    // @scos/api-acceptance.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
