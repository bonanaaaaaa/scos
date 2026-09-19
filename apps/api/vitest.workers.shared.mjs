// Shared by the workerd test projects (vitest.workers.config.mjs and
// vitest.workers.integration.config.mjs).
//
// pg is CommonJS. In workerd, the pool loads it through its CommonJS module
// fallback, which resolves pg's require() calls without the "workerd"
// condition Wrangler's bundler uses for the deployed Worker, and so gets
// pg-protocol's ES module build (an ES module in a CommonJS package) and
// pg-cloudflare's empty Node stub (no CloudflareSocket, so no connection).
// Point both at the CommonJS builds the deployed bundle effectively uses.
import { createRequire } from "node:module";

const pgRequire = createRequire(createRequire(import.meta.url).resolve("pg"));
const pgCloudflare = pgRequire.resolve("pg-cloudflare").replace(/empty\.js$/, "index.js");

export const workerdAliases = [
  { find: /^pg-protocol$/, replacement: pgRequire.resolve("pg-protocol") },
  { find: /^pg-cloudflare$/, replacement: pgCloudflare },
];
