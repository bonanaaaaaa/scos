// QA acceptance against a deployed API (issue #33), reached over the network
// with real fetch.
//
// Deliberately its own config and its own script (`test:hosted`), wired into
// no turbo task: it needs a live HOSTED_BASE_URL, which CI, `turbo run test`
// and `test:integration` do not have, and every run spends real, finite,
// never-replenished hosted stock.
//
// Two differences from ./vitest.config.mjs are load-bearing, not incidental:
//
//  1. **No `globalSetup`.** ./test/global-setup.ts migrates, seeds and drops a
//     database, and in its `API_BASE_URL` mode it wipes every Order and
//     warehouse row of a database that already exists. None of that may ever
//     run against the hosted demonstration. This suite therefore loads no
//     global setup at all and opens no database connection; its only contact
//     with the deployment is HTTP.
//  2. **A different file suffix.** ./vitest.config.mjs collects
//     `test/**/*.acceptance.test.ts` — recursive, so a subdirectory alone
//     would not keep these files out of it. `*.hosted.test.ts` does, and
//     `vitest list --config vitest.config.mjs` is the check that proves it.
//
// Keep both. Merging this suite into the external mode would be a data-loss
// bug; see the note at the top of test/hosted/acceptance.hosted.test.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/hosted/**/*.hosted.test.ts"],
    // One file that creates exactly one Order, so its scenarios must observe
    // the deployment in order and never race each other for shared stock.
    fileParallelism: false,
    // Every assertion is a round trip to a remote Worker that may cold-start,
    // and reading the inventory takes a bounded series of them.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
