/**
 * Runs once before any acceptance test and once after the last one.
 *
 * Default (shared) mode: create a disposable database beside `scos_test`,
 * migrate and seed it, start the built API against it, and hand the base URL
 * and database URL to the test files. Afterwards the server is stopped and
 * the database dropped, so a run leaves no process listening and no database
 * behind.
 *
 * Real-server mode (`API_BASE_URL` set): no server is started. The database
 * named by `DATABASE_TEST_URL` is migrated and seeded in place and is never
 * dropped; every test calls the given URL. Reachability is checked with a
 * bare TCP connect rather than a request, so the setup records no trace and
 * no request log on the server under test.
 *
 * A failure here fails the run. Nothing in this suite skips.
 *
 * @module
 */

import { connect } from "node:net";
import type { TestProject } from "vitest/node";

import { type ApiProcess, spawnApi } from "#test/support/api-process";
import { readEnvironment, requireApiArtifacts } from "#test/support/environment";
import {
  type AcceptanceDatabase,
  createAcceptanceDatabase,
  prepareExistingDatabase,
} from "#test/support/provision";

/** How long the already-running server has to accept a TCP connection. */
const REACHABLE_TIMEOUT_MS = 5_000;

/**
 * Opens and immediately closes a TCP connection. Deliberately not an HTTP
 * request: an unreachable `API_BASE_URL` must fail loudly without recording
 * anything on a server that is reachable.
 */
async function requireReachable(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  const port = Number(url.port !== "" ? url.port : url.protocol === "https:" ? 443 : 80);
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port });
    const fail = (reason: string) => {
      socket.destroy();
      reject(new Error(`API_BASE_URL ${baseUrl} is not reachable: ${reason}.`));
    };
    socket.setTimeout(REACHABLE_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("timeout", () => fail(`no connection within ${REACHABLE_TIMEOUT_MS} ms`));
    socket.once("error", (error: Error) => fail(error.message));
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Both modes need the artifact: even against a running server, the tests
  // that need a differently configured API start their own process from it.
  requireApiArtifacts();
  const environment = readEnvironment();

  let database: AcceptanceDatabase;
  let server: ApiProcess | undefined;
  let baseUrl: string;

  if (environment.mode === "external") {
    await requireReachable(environment.baseUrl);
    database = await prepareExistingDatabase(environment.databaseUrl);
    baseUrl = environment.baseUrl;
  } else {
    database = await createAcceptanceDatabase(environment.adminUrl);
    try {
      // Exporters stay at their "none" defaults, so the shared server records
      // no spans and no metrics; LOG_LEVEL stays at the default "info" so the
      // listening record exists to wait for.
      server = await spawnApi({
        databaseUrl: database.url,
        env: { OTEL_SERVICE_NAME: "scos-api-acceptance" },
      });
    } catch (error) {
      await database.drop();
      throw error;
    }
    baseUrl = server.baseUrl;
  }

  project.provide("apiBaseUrl", baseUrl);
  project.provide("acceptanceDatabaseUrl", database.url);
  project.provide("acceptanceMode", environment.mode);

  return async () => {
    try {
      if (server !== undefined) {
        const code = await server.stop();
        if (code !== 0 && code !== null) {
          throw new Error(
            `The API process exited with code ${String(code)}.\n\nstderr:\n${server.stderr()}`,
          );
        }
      }
    } finally {
      await database.drop();
    }
  };
}
