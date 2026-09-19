/**
 * The database side of every database-backed composition: a bounded pg pool
 * and the Prisma client over it.
 *
 * Nothing connects until the first query, so building a composition never
 * touches the database. Connecting is bounded by `connectionTimeoutMs`, which
 * elapses before any statement is sent, so a timeout there is always safe to
 * retry. Deliberately no client-side query timeout is set: pg abandons a
 * timed-out query without closing its connection, which can return a
 * connection with an open transaction to the pool. Statements are bounded
 * server-side instead (`lock_timeout` and `statement_timeout` in the
 * submission transaction).
 *
 * @module
 */

import {
  type DatabasePoolOptions,
  type PrismaClient,
  createDatabasePool,
  createPrismaClient,
} from "@scos/persistence";
import type { Hono } from "hono";
import type { Pool } from "pg";

import type { Logger } from "./http/logger";

/** Default limit for acquiring or opening a pooled connection. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * pg pool options for the API. `connectionTimeoutMs` must be a positive
 * integer: pg treats 0 as "wait forever".
 */
export function databasePoolTimeouts(
  connectionTimeoutMs: number = DEFAULT_CONNECTION_TIMEOUT_MS,
): DatabasePoolOptions {
  if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs < 1) {
    throw new RangeError("connectionTimeoutMs must be a positive integer number of milliseconds.");
  }
  return { connectionTimeoutMillis: connectionTimeoutMs };
}

export interface ComposedApplication {
  readonly app: Hono;
  /** Releases what the composition opened. Safe to call more than once. */
  close(): Promise<void>;
}

/** Options every database-backed composition accepts. */
export interface DatabaseCompositionOptions {
  /** A validated PostgreSQL connection string (see `config.ts`). */
  readonly databaseUrl: string;
  readonly logger?: Logger;
  /** Limit for acquiring or opening a connection; {@link DEFAULT_CONNECTION_TIMEOUT_MS}. */
  readonly connectionTimeoutMs?: number;
  /**
   * Builds the pg pool in place of `createDatabasePool(databaseUrl, timeouts)`.
   * It receives the bounded timeouts and must apply them. The Lambda adapter
   * (`src/lambda/pool.ts`) uses it for one connection per execution
   * environment and IAM database authentication.
   */
  readonly createPool?: (timeouts: DatabasePoolOptions) => Pool;
}

export interface Database {
  readonly prisma: PrismaClient;
  close(): Promise<void>;
}

/** Pool and Prisma client; nothing connects until the first query. */
export function openDatabase(options: DatabaseCompositionOptions): Database {
  const timeouts = databasePoolTimeouts(options.connectionTimeoutMs);
  const pool = options.createPool?.(timeouts) ?? createDatabasePool(options.databaseUrl, timeouts);
  const prisma = createPrismaClient(pool);
  let closing: Promise<void> | undefined;
  return {
    prisma,
    close() {
      // Disconnect Prisma first, then end the pool it borrows.
      closing ??= (async () => {
        try {
          await prisma.$disconnect();
        } finally {
          await pool.end();
        }
      })();
      return closing;
    },
  };
}

/**
 * Builds an app over a freshly opened database. If building fails, the pool
 * is closed and the error rethrown.
 */
export function composeOverDatabase(
  options: DatabaseCompositionOptions,
  build: (prisma: PrismaClient) => Hono,
): ComposedApplication {
  const database = openDatabase(options);
  try {
    return { app: build(database.prisma), close: database.close };
  } catch (error) {
    // Not awaited: pg connects lazily, so nothing has connected yet.
    void database.close().catch(() => undefined);
    throw error;
  }
}

export function withLogger(logger: Logger | undefined): { logger?: Logger } {
  return logger === undefined ? {} : { logger };
}
