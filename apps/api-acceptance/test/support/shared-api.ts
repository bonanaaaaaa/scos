/**
 * The shared served API, as the test files see it.
 *
 * Whether the global setup started the server or `API_BASE_URL` pointed at
 * one already running, a test file gets the same `ApiUnderTest` shape, so no
 * test body branches on the mode. Extra processes a test starts itself
 * (`spawnApi`) satisfy the same interface.
 *
 * ## The channel from the global setup
 *
 * ../global-setup.ts runs in Playwright's main process and the test files run
 * in a worker process, so the three values below travel as environment
 * variables: the worker is started after the global setup has resolved and
 * inherits its environment, which makes them readable here at module scope —
 * where the test files call {@link sharedApi}. Playwright offers nothing else
 * that is available that early; it imports every test file before the first
 * fixture or setup project runs.
 *
 * The variables are this app's own, and nothing but ../global-setup.ts writes
 * them. Reading one that is missing fails loudly, because a suite that
 * silently ran against nothing would be worse than one that did not run.
 * Nothing in the hosted suite imports this module: see the docblock of
 * ../hosted/acceptance.hosted.test.ts.
 *
 * @module
 */

import type { ApiUnderTest } from "./api-process";

const API_BASE_URL = "SCOS_ACCEPTANCE_API_BASE_URL";
const DATABASE_URL = "SCOS_ACCEPTANCE_DATABASE_URL";
const MODE = "SCOS_ACCEPTANCE_MODE";

/** What the global setup hands to every acceptance test file. */
export interface AcceptanceContext {
  /** The served API every test calls: the shared server, or API_BASE_URL. */
  readonly apiBaseUrl: string;
  /** The database that server uses; tests read and reset stock through it. */
  readonly acceptanceDatabaseUrl: string;
  /** "shared" when this run started the server, "external" for API_BASE_URL. */
  readonly acceptanceMode: "shared" | "external";
}

/** Called once by the global setup, before any worker exists. */
export function provideAcceptanceContext(context: AcceptanceContext): void {
  process.env[API_BASE_URL] = context.apiBaseUrl;
  process.env[DATABASE_URL] = context.acceptanceDatabaseUrl;
  process.env[MODE] = context.acceptanceMode;
}

function provided(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} was not provided by the acceptance global setup. Run this suite as its own ` +
        "project, with `pnpm --filter @scos/api-acceptance run test:acceptance`.",
    );
  }
  return value;
}

/**
 * The API every test in this run calls.
 *
 * Every test file calls this at module scope, and Playwright imports test
 * files for `--list` too, where no global setup has run. The base URL is
 * therefore read on access rather than on construction: listing the suite
 * never needs a provisioned server, while a test that actually sends a
 * request to one that was never provisioned still fails loudly.
 */
export function sharedApi(): ApiUnderTest {
  return {
    get baseUrl(): string {
      return provided(API_BASE_URL);
    },
  };
}

/** The database that API uses: where stock is read and reset. */
export function acceptanceDatabaseUrl(): string {
  return provided(DATABASE_URL);
}

/** "shared" when this run started the server, "external" for API_BASE_URL. */
export function acceptanceMode(): "shared" | "external" {
  return provided(MODE) === "external" ? "external" : "shared";
}
