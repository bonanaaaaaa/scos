/**
 * The acceptance run's database: created beside `scos_test`, migrated with
 * the persistence package's own Prisma CLI, seeded with the six PRD
 * warehouses, and dropped afterwards.
 *
 * Mirrors `apps/api/test/support/database.ts`, with one deliberate
 * difference: the developer suite creates a database per test file, while
 * the acceptance suite creates **one** for the whole run, because a single
 * served API is started against it. Test files run one at a time
 * (`fileParallelism: false`) and reset stock through the database between
 * tests.
 *
 * Used only by the global setup. Test files talk to the database through
 * `database.ts`.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { seedWarehouses } from "@scos/persistence";
import { Client } from "pg";

import { openPool } from "#test/support/database";

const execFileAsync = promisify(execFile);

/** The persistence workspace package (migrations, prisma.config.ts, CLI). */
const persistenceDirectory = realpathSync(
  fileURLToPath(new URL("../../node_modules/@scos/persistence/", import.meta.url)),
);
const prismaCli = `${persistenceDirectory}/node_modules/.bin/prisma`;

function adminClient(url: string): Client {
  return new Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
}

/** Applies every migration to `databaseUrl` with the persistence Prisma CLI. */
export async function migrate(databaseUrl: string): Promise<void> {
  await execFileAsync(prismaCli, ["migrate", "deploy"], {
    cwd: persistenceDirectory,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 60_000,
  });
}

/** Seeds the six PRD warehouses with their full stock. */
export async function seed(databaseUrl: string): Promise<void> {
  const pool = openPool(databaseUrl);
  try {
    await seedWarehouses(pool);
  } finally {
    await pool.end();
  }
}

export interface AcceptanceDatabase {
  readonly url: string;
  /** Drops the database. A no-op for a database this suite did not create. */
  drop(): Promise<void>;
}

/**
 * Creates a uniquely named database beside `scos_test`, migrates and seeds
 * it. On a migration failure the database is dropped before the error is
 * rethrown, so a failed run leaves nothing behind.
 */
export async function createAcceptanceDatabase(adminUrl: string): Promise<AcceptanceDatabase> {
  const name = `scos_acceptance_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  const admin = adminClient(adminUrl);
  await admin.connect();
  try {
    const current = await admin.query<{ name: string }>("SELECT current_database() AS name");
    if (current.rows[0]?.name !== "scos_test") {
      throw new Error("Expected to be connected to scos_test");
    }
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const drop = async () => {
    const cleanup = adminClient(adminUrl);
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };

  try {
    await migrate(databaseUrl);
    await seed(databaseUrl);
  } catch (error) {
    await drop();
    throw error;
  }

  return { url: databaseUrl, drop };
}

/**
 * Prepares a database this suite did not create (external mode): migrated and
 * seeded in place, never dropped.
 */
export async function prepareExistingDatabase(databaseUrl: string): Promise<AcceptanceDatabase> {
  await migrate(databaseUrl);
  await seed(databaseUrl);
  return { url: databaseUrl, drop: async () => undefined };
}
