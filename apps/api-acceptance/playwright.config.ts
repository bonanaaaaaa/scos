/**
 * The QA acceptance suite's runner: Playwright Test over HTTP only.
 *
 * These are API tests. Nothing here requests Playwright's `page`, `browser`
 * or `context` fixtures, so **no browser is ever launched and none needs to
 * be downloaded** (`playwright install` is not part of this app's setup); the
 * suite's only clients are `fetch` and `pg`.
 *
 * ## Two projects, and why their separation is load-bearing
 *
 * - **acceptance** — `test/*.acceptance.test.ts`, run against a server and a
 *   database this run provisions. {@link "./test/global-setup"} migrates,
 *   seeds and (in `API_BASE_URL` mode) **wipes** that database.
 * - **hosted** — `test/hosted/*.hosted.test.ts`, run against the live
 *   Cloudflare demonstration named by `HOSTED_BASE_URL`, whose data must
 *   survive and whose stock is finite and never replenished. It must never
 *   load the global setup, never open a database connection, and never read
 *   `API_BASE_URL`. See the module docblock of
 *   `test/hosted/acceptance.hosted.test.ts`.
 *
 * Playwright's `globalSetup` is a property of the **configuration**, not of a
 * project: it runs for every invocation of this config, whichever project was
 * selected (`FullConfig.projects` is not filtered by `--project`, and
 * `globalSetup` receives no other signal). A project-level `setup` project
 * would be filtered correctly, but Playwright collects every test file
 * *before* a setup project runs, and these suites read the provisioned base
 * URL at module scope — so that route cannot work here either.
 *
 * This config therefore reads the selected projects from the command line
 * itself, in the same main process Playwright parsed them in, and only wires
 * `globalSetup` when the acceptance project is actually going to run. Both
 * package scripts always pass `--project`, so `run test:hosted` loads no
 * global setup at all.
 *
 * @module
 */

import { randomUUID } from "node:crypto";

import { defineConfig } from "@playwright/test";

const ACCEPTANCE = "acceptance";
const HOSTED = "hosted";

/**
 * The project names this invocation selected, in Playwright's own spellings:
 * `--project=a`, `--project a`, and several values after one flag
 * (`--project a b`). An empty result means no `--project` was passed, which
 * in Playwright means "every project".
 */
function selectedProjects(argv: readonly string[]): string[] {
  const selected: string[] = [];
  let collecting = false;
  for (const argument of argv) {
    if (argument === "--project") {
      collecting = true;
      continue;
    }
    if (argument.startsWith("--project=")) {
      selected.push(argument.slice("--project=".length));
      collecting = false;
      continue;
    }
    if (collecting && !argument.startsWith("-")) {
      selected.push(argument);
      continue;
    }
    collecting = false;
  }
  return selected;
}

const selected = selectedProjects(process.argv);

/**
 * Which projects this invocation runs.
 *
 * With no `--project`, only `acceptance` runs. Playwright's own default would
 * be "every project", which here would include `hosted` — and that submits a
 * real Order against the live demonstration, permanently consuming one unit
 * of a finite, never-replenished inventory. A bare `playwright test` (or
 * `--grep`, `--last-failed`, `--ui`, `--shard` with no project) must not be
 * able to spend it by accident, so the hosted project is opt-in only.
 */
const runs = (project: string) =>
  selected.length === 0 ? project === "acceptance" : selected.includes(project);

/**
 * Reports go to their own directory per selection, so the acceptance and
 * hosted runs never overwrite each other's JUnit XML or HTML report. The
 * whole tree is a build artifact and is gitignored.
 *
 * Seeded into the environment because Playwright loads this config in its
 * worker processes too, and a worker's own `process.argv` carries no
 * `--project`: computing the directory there would send a failing test's
 * attachments somewhere other than where the reporters are writing.
 */
process.env.SCOS_PLAYWRIGHT_REPORT_DIR ??= `test-results/${selected.length === 1 ? (selected[0] as string) : "all"}`;
const reportDirectory = process.env.SCOS_PLAYWRIGHT_REPORT_DIR;

/**
 * One identifier for the whole hosted run, seeded here in the main process so
 * every worker — including a worker started for a **retry** — inherits it
 * through the environment. `test/hosted/support.ts` builds its submissionIds
 * from it, which is what keeps a retry a replay of the same Order rather than
 * a second one: the hosted suite's budget is exactly 1 unit of stock per run
 * and the deployment's stock is never replenished.
 */
process.env.SCOS_HOSTED_RUN_ID ??= randomUUID();

export default defineConfig({
  // Only when the acceptance project will run; see this module's docblock.
  ...(runs(ACCEPTANCE) ? { globalSetup: "./test/global-setup.ts" } : {}),
  // The whole run shares one served API and one database, and the hosted
  // suite's scenarios observe one deployment in order. Nothing here may run
  // beside anything else.
  workers: 1,
  fullyParallel: false,
  // Playwright has one timeout knob where Vitest had two (`testTimeout` and
  // `hookTimeout`); this is the larger of the pair, because the hooks are
  // what start database migrations and child API processes.
  timeout: 120_000,
  forbidOnly: true,
  // Traces, screenshots and other per-test attachments. A sibling of the HTML
  // report, never its parent or its child.
  outputDir: `${reportDirectory}/artifacts`,
  reporter: [
    // Progress: annotated failures on CI, one line per test locally.
    process.env.CI ? ["github"] : ["list"],
    // Machine-readable, for CI test reporting.
    ["junit", { outputFile: `${reportDirectory}/junit.xml` }],
    // Browsable, with the failure's full context. Never opened automatically:
    // a run that ends by launching a web server is a bad citizen in CI.
    ["html", { outputFolder: `${reportDirectory}/html`, open: "never" }],
  ],
  // The hosted project is present only when it is asked for by name. Listing
  // it unconditionally would make a bare `playwright test` (or `--grep`,
  // `--last-failed`, `--ui`, `--shard` with no project) run it, and that
  // submits a real Order against the live demonstration, permanently spending
  // one unit of an inventory that is never replenished. Gating `globalSetup`
  // alone does not prevent this: project collection is separate from it.
  projects: [
    {
      name: ACCEPTANCE,
      testDir: "./test",
      testMatch: /.*\.acceptance\.test\.ts$/,
      // Deliberately none. These tests assert on stock deltas and on "nothing
      // was stored"; a silent retry could hide a real oversell or a double
      // deduction behind a green run.
      retries: 0,
    },
    ...(selected.includes(HOSTED)
      ? [
          {
            name: HOSTED,
            testDir: "./test/hosted",
            testMatch: /.*\.hosted\.test\.ts$/,
            // Reading the remote inventory takes a bounded series of round trips,
            // and the first of them may wait for a cold start.
            timeout: 180_000,
            // No retries, deliberately. A retry here costs no stock — the run's
            // submissionIds are stable (see SCOS_HOSTED_RUN_ID), so a repeated
            // submission replays the same Order — but it also cannot go green once
            // the Order has been submitted: the replay deducts nothing, so
            // "the accepted Order deducted its allocation" asserts stock <= stock - 1
            // and fails every time. Worse, it fails reporting a deduction problem,
            // which is exactly the bug class this suite exists to detect. A retry
            // would only help for a failure before the submission, and a misleading
            // red run is a poor trade for that. This suite is run by hand; rerun it.
            retries: 0,
          },
        ]
      : []),
  ],
});
