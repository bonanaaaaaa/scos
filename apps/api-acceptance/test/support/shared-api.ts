/**
 * The shared served API, as the test files see it.
 *
 * Whether the global setup started the server or `API_BASE_URL` pointed at
 * one already running, a test file gets the same `ApiUnderTest` shape, so no
 * test body branches on the mode. Extra processes a test starts itself
 * (`spawnApi`) satisfy the same interface.
 *
 * @module
 */

import { inject } from "vitest";

import type { ApiUnderTest } from "./api-process";

/** The API every test in this run calls. */
export function sharedApi(): ApiUnderTest {
  return { baseUrl: inject("apiBaseUrl") };
}

/** The database that API uses: where stock is read and reset. */
export function acceptanceDatabaseUrl(): string {
  return inject("acceptanceDatabaseUrl");
}

/** "shared" when this run started the server, "external" for API_BASE_URL. */
export function acceptanceMode(): "shared" | "external" {
  return inject("acceptanceMode");
}
