import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client, DatabaseError, type Pool } from "pg";
import { expect } from "vitest";

import { createDatabasePool } from "../../src/database.js";
import { createPrismaClient, type PrismaClient } from "../../src/prisma.js";

const execFileAsync = promisify(execFile);

export const packageDirectory = fileURLToPath(new URL("../..", import.meta.url));
const prismaCli = fileURLToPath(new URL("../../node_modules/.bin/prisma", import.meta.url));

/**
 * Returns DATABASE_TEST_URL after the same isolation guard as the connectivity
 * harness: it must name the dedicated scos_test database and differ from
 * DATABASE_URL. These are safety guards rather than test expectations, so they
 * throw plainly before any database is created or dropped.
 */
export function requireTestDatabaseUrl(): string {
  const databaseTestUrl = process.env.DATABASE_TEST_URL;
  if (!databaseTestUrl) {
    throw new Error("DATABASE_TEST_URL must point to the isolated test database");
  }
  if (databaseTestUrl === process.env.DATABASE_URL) {
    throw new Error("DATABASE_TEST_URL must differ from DATABASE_URL");
  }
  if (new URL(databaseTestUrl).pathname !== "/scos_test") {
    throw new Error("DATABASE_TEST_URL must name the dedicated scos_test database");
  }
  return databaseTestUrl;
}

function adminClient(url: string): Client {
  return new Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
}

export interface MigratedDatabase {
  readonly name: string;
  readonly url: string;
  readonly pool: Pool;
  readonly prisma: PrismaClient;
  drop(): Promise<void>;
}

export async function runPrisma(
  args: readonly string[],
  databaseUrl: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(prismaCli, [...args], {
    cwd: packageDirectory,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 60_000,
  });
}

/**
 * Creates a uniquely named database beside scos_test in the disposable test
 * server, applies the real migrations with `prisma migrate deploy`, and
 * returns a pg pool plus a Prisma client built on that pool. Each test file
 * gets its own database, so parallel files and concurrent worktrees never
 * share schema state. drop() removes the database.
 */
export async function createMigratedDatabase(): Promise<MigratedDatabase> {
  const testUrl = requireTestDatabaseUrl();
  const name = `scos_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(testUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  if (databaseUrl === process.env.DATABASE_URL) {
    throw new Error("The per-file test database URL must differ from DATABASE_URL");
  }

  const admin = adminClient(testUrl);
  await admin.connect();
  try {
    const current = await admin.query<{ name: string }>("SELECT current_database() AS name");
    const connectedDatabase = current.rows[0]?.name;
    if (connectedDatabase !== "scos_test") {
      throw new Error(
        `Expected to be connected to scos_test, but current_database() is ${String(connectedDatabase)}`,
      );
    }
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const drop = async () => {
    const cleanup = adminClient(testUrl);
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };

  try {
    await runPrisma(["migrate", "deploy"], databaseUrl);
  } catch (error) {
    await drop();
    throw error;
  }

  const pool = createDatabasePool(databaseUrl);
  const prisma = createPrismaClient(pool);
  return {
    name,
    url: databaseUrl,
    pool,
    prisma,
    drop: async () => {
      const failures: unknown[] = [];
      for (const step of [() => prisma.$disconnect(), () => pool.end(), drop]) {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Test database cleanup failed");
      }
    },
  };
}

/** Asserts that a query fails with the given SQLSTATE and constraint name. */
export async function assertDatabaseError(
  operation: Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  const error: unknown = await operation.then(
    () => expect.fail(`expected a PostgreSQL error ${expected.code}, but the operation resolved`),
    (reason: unknown) => reason,
  );
  expect(error, `expected a PostgreSQL error, got ${String(error)}`).toBeInstanceOf(DatabaseError);
  // Unreachable after the expect above; narrows the type for TypeScript.
  if (!(error instanceof DatabaseError)) {
    throw new TypeError(`expected a PostgreSQL error, got ${String(error)}`);
  }
  expect(error.code, error.message).toBe(expected.code);
  if (expected.constraint !== undefined) {
    expect(error.constraint, error.message).toBe(expected.constraint);
  }
}
