import { configDefaults, defineConfig } from "vitest/config";

// Modules that only run inside workerd. They are tested there
// (vitest.workers.config.mjs, `test:workers`), where V8 coverage is not
// available, so they are left out of this project's coverage gates.
const workersOnly = [
  "src/telemetry/workers/**",
  "src/composition/worker.ts",
  "src/entrypoints/worker.ts",
  "src/entrypoints/worker.unused-module.ts",
  "src/testing/workers-telemetry.test-support.ts",
];

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "src/**/*.workers.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportOnFailure: true,
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", ...workersOnly],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
