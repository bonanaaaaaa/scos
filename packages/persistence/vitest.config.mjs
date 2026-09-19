import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportOnFailure: true,
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      // src/testing.ts is the integration-test harness: it needs a real
      // PostgreSQL and is exercised by test:integration, not by unit tests.
      exclude: ["src/**/*.test.ts", "src/generated/**", "src/testing.ts"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
