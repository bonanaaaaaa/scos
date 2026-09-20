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

import type { Logger } from "#http/logger";
import { instrumentApp } from "#telemetry/http";
import type { Telemetry } from "#telemetry/telemetry";

import type { ComposedApplication } from "./composed-application";

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

export type { ComposedApplication } from "./composed-application";

/** Options every database-backed composition accepts. */
export interface DatabaseCompositionOptions {
  /** A validated PostgreSQL connection string (see `config.ts`). */
  readonly databaseUrl: string;
  readonly logger?: Logger;
  /**
   * Traces and meters the app, its use cases and its persistence ports.
   * Omitted: nothing is instrumented (unit tests, offline tools).
   */
  readonly telemetry?: Telemetry;
  /** Limit for acquiring or opening a connection; {@link DEFAULT_CONNECTION_TIMEOUT_MS}. */
  readonly connectionTimeoutMs?: number;
}

export interface Database {
  readonly prisma: PrismaClient;
  close(): Promise<void>;
}

/** Pool and Prisma client; nothing connects until the first query. */
export function openDatabase(options: DatabaseCompositionOptions): Database {
  const pool = createDatabasePool(
    options.databaseUrl,
    databasePoolTimeouts(options.connectionTimeoutMs),
  );
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
 * Wraps `app` with the HTTP server instrumentation when telemetry is
 * configured; returns it unchanged otherwise.
 */
export function withHttpTelemetry(
  app: Hono,
  options: { readonly telemetry?: Telemetry; readonly logger?: Logger },
): Hono {
  return options.telemetry === undefined
    ? app
    : instrumentApp(app, options.telemetry, options.logger);
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
    return { app: withHttpTelemetry(build(database.prisma), options), close: database.close };
  } catch (error) {
    // Not awaited: pg connects lazily, so nothing has connected yet.
    void database.close().catch(() => undefined);
    throw error;
  }
}

export function withLogger(logger: Logger | undefined): { logger?: Logger } {
  return logger === undefined ? {} : { logger };
}
