// The Worker (src/entrypoints/worker.ts) inside workerd against real
// PostgreSQL through its Hyperdrive binding, with no Cloudflare account.
// global-setup.ts creates an isolated database from DATABASE_TEST_URL, as the
// Node integration tests do, and the binding points at it.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { workerdAliases } from "./vitest.workers.shared.mjs";

export default defineConfig({
  plugins: [
    cloudflareTest(({ inject }) => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { hyperdrives: { HYPERDRIVE: inject("workerDatabaseUrl") } },
    })),
  ],
  resolve: { alias: workerdAliases },
  test: {
    include: ["test/workers/**/*.workers.integration.test.ts"],
    globalSetup: ["test/workers/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
