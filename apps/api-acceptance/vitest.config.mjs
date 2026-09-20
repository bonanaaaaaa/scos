import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.acceptance.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // One served API and one database are shared by the whole run, so files
    // must not overlap: they reset stock through the database between tests.
    fileParallelism: false,
    // A file may start extra API processes and hold row locks; give slow CI
    // runners room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
