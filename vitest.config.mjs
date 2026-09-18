import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportOnFailure: true,
      reportsDirectory: "coverage",
      include: ["scripts/**/*.mjs"],
      exclude: ["scripts/**/*.test.mjs"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
