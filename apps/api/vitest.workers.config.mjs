// Unit tests that run inside workerd (the Cloudflare Workers runtime) with
// @cloudflare/vitest-pool-workers, against the Worker's own wrangler.jsonc
// (compatibility date, nodejs_compat). They need no database and no
// Cloudflare account. The Node unit tests (vitest.config.mjs) exclude these
// files; coverage gates apply to the Node project only.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { workerdAliases } from "./vitest.workers.shared.mjs";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  resolve: { alias: workerdAliases },
  test: {
    include: ["src/**/*.workers.test.ts"],
  },
});
