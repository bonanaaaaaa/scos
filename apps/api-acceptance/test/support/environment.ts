/**
 * The only module in this app that reads `process.env` or resolves a path
 * into `apps/api`.
 *
 * The acceptance suite never imports API source: its whole contact with the
 * API is the built artifact, environment variables, HTTP and process output.
 * That makes the environment the suite's contract, so every variable is
 * validated once, here, with a message that says what to do about it. A
 * missing variable or a missing artifact fails the run; nothing is ever
 * skipped.
 *
 * Two modes:
 *
 * - **shared** (default): the global setup creates a disposable database
 *   beside `scos_test` and starts the built API against it.
 * - **external** (`API_BASE_URL` set): nothing is started; every test calls
 *   that URL, and `DATABASE_TEST_URL` must be the database that server uses.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `apps/api`, the working directory a spawned API process is given. */
export const apiDirectory = fileURLToPath(new URL("../../../api/", import.meta.url));
/** The built Node.js server: the only executable this suite runs. */
export const apiBundle = fileURLToPath(new URL("../../../api/dist/node.js", import.meta.url));
/** The built OpenAPI document, compared with the served one. */
export const openApiArtifact = fileURLToPath(
  new URL("../../../api/dist/openapi.json", import.meta.url),
);

const BUILD_HINT = "run `pnpm --filter @scos/api build` first";

/**
 * Fails unless both build artifacts exist. Checked once in the global setup,
 * before a database is created, so a forgotten build costs nothing.
 */
export function requireApiArtifacts(): void {
  for (const path of [apiBundle, openApiArtifact]) {
    if (!existsSync(path)) {
      throw new Error(`The API build artifact ${path} is missing: ${BUILD_HINT}.`);
    }
  }
}

export type AcceptanceMode = "shared" | "external";

export interface SharedEnvironment {
  readonly mode: "shared";
  /** The `scos_test` administrative URL a disposable database is created beside. */
  readonly adminUrl: string;
}

export interface ExternalEnvironment {
  readonly mode: "external";
  /** The already-running server every test calls. */
  readonly baseUrl: string;
  /** That server's database; this suite migrates, seeds and resets it. */
  readonly databaseUrl: string;
}

export type AcceptanceEnvironment = SharedEnvironment | ExternalEnvironment;

function requireDatabaseTestUrl(): string {
  const databaseTestUrl = process.env.DATABASE_TEST_URL;
  if (!databaseTestUrl) {
    throw new Error(
      "DATABASE_TEST_URL must point to the test database; the acceptance suite fails rather than skipping without it.",
    );
  }
  return databaseTestUrl;
}

/** Names the database an external run is allowed to migrate, seed and reset. */
export const resetConfirmationVariable = "SCOS_CONFIRM_ACCEPTANCE_RESET";

/**
 * Guards the one destructive mode this suite has.
 *
 * The default mode creates its own disposable database and needs no
 * confirmation. External mode is different: the caller names a database that
 * already exists and that a running server is using, and this suite migrates,
 * seeds and then wipes it between test files. So the caller must name that
 * exact database, exactly as `SCOS_CONFIRM_DATABASE_RESET` guards
 * `pnpm db:reset`. Setting `API_BASE_URL` is not on its own consent to lose
 * the data behind it.
 */
function confirmExternalReset(databaseTestUrl: string): void {
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(databaseTestUrl).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_TEST_URL must be a valid PostgreSQL connection URL");
  }
  if (databaseName.length === 0) {
    throw new Error("DATABASE_TEST_URL must name the database the suite may reset");
  }
  if (process.env[resetConfirmationVariable] !== databaseName) {
    throw new Error(
      `Refusing to run against API_BASE_URL with database "${databaseName}". ` +
        "This suite migrates, seeds and deletes every Order and warehouse row in it. " +
        `To confirm, rerun with ${resetConfirmationVariable}=${databaseName}.`,
    );
  }
}

/**
 * Reads and validates the environment.
 *
 * In shared mode the `scos_test` guards of the developer suite apply in full:
 * the URL must name the dedicated `scos_test` database and differ from
 * DATABASE_URL, because the suite is about to create and drop databases
 * beside it.
 *
 * In external mode both guards are deliberately relaxed: the caller points
 * DATABASE_TEST_URL at the database the running server already uses, which is
 * legitimately its DATABASE_URL and need not be named `scos_test`. What
 * replaces them is {@link confirmExternalReset}, which makes the caller name
 * that database, so the data loss is chosen rather than inherited from
 * `API_BASE_URL` (see the app README and issue #33).
 */
export function readEnvironment(): AcceptanceEnvironment {
  const databaseTestUrl = requireDatabaseTestUrl();
  const baseUrl = process.env.API_BASE_URL;

  if (baseUrl !== undefined && baseUrl !== "") {
    if (!URL.canParse(baseUrl)) {
      throw new Error("API_BASE_URL must be an absolute http:// or https:// URL.");
    }
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("API_BASE_URL must be an http:// or https:// URL.");
    }
    confirmExternalReset(databaseTestUrl);
    return {
      mode: "external",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      databaseUrl: databaseTestUrl,
    };
  }

  if (databaseTestUrl === process.env.DATABASE_URL) {
    throw new Error("DATABASE_TEST_URL must differ from DATABASE_URL");
  }
  if (new URL(databaseTestUrl).pathname !== "/scos_test") {
    throw new Error("DATABASE_TEST_URL must name the dedicated scos_test database");
  }
  return { mode: "shared", adminUrl: databaseTestUrl };
}
