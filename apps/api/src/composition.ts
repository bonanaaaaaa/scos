/**
 * Composition roots: wire the PostgreSQL adapters into the core use cases and
 * the use cases into the Hono apps.
 *
 * One per endpoint, each building only what its endpoint needs (for one
 * Lambda function per endpoint, #14):
 *
 * - health: nothing (no configuration, no pool)
 * - verify: pool -> Prisma client -> inventory reader -> VerifyOrder -> app
 * - submit: pool -> Prisma client -> submission store -> SubmitOrder -> app
 *
 * `composeApplication` builds all routes over one pool for the local server.
 *
 * Building it opens no connection (pg connects lazily on the first query), so
 * `/health` answers even while the database is unreachable. `close()` releases
 * Prisma's use of the pool and then ends the pool.
 *
 * Connecting is bounded by `connectionTimeoutMs`, which elapses before any
 * statement is sent, so a timeout there is always safe to retry. Deliberately
 * no client-side query timeout is set: pg abandons a timed-out query without
 * closing its connection, which can return a connection with an open
 * transaction to the pool. Statements are bounded server-side instead
 * (`lock_timeout` and `statement_timeout` in the submission transaction).
 *
 * @module
 */

import {
  type SubmissionStore,
  type SubmitOrder,
  type VerifyOrder,
  createSubmitOrder,
  createVerifyOrder,
} from "@scos/core";
import {
  type DatabasePoolOptions,
  type PrismaClient,
  type PrismaSubmissionStoreOptions,
  createDatabasePool,
  createPrismaClient,
  createPrismaInventoryReader,
  createPrismaSubmissionStore,
} from "@scos/persistence";
import type { Hono } from "hono";

import {
  type Logger,
  createApp,
  createHealthApp,
  createSubmitOrderApp,
  createVerifyOrderApp,
} from "./app";

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
}

export type VerifyOrderCompositionOptions = DatabaseCompositionOptions;

export interface SubmitOrderCompositionOptions extends DatabaseCompositionOptions {
  /** Transaction timeouts for submissions; persistence defaults apply otherwise. */
  readonly submissionStore?: PrismaSubmissionStoreOptions;
  /** Total SubmitOrder attempts for transient failures; core default otherwise. */
  readonly maxSubmissionAttempts?: number;
  /**
   * Wraps the real submission store. Tests use it to inject failures at a
   * given stage while every request still goes through the composed app.
   */
  readonly decorateSubmissionStore?: (store: SubmissionStore) => SubmissionStore;
}

/** Everything, for the local server: all options of both database endpoints. */
export type CompositionOptions = SubmitOrderCompositionOptions;

interface Database {
  readonly prisma: PrismaClient;
  close(): Promise<void>;
}

/** Pool and Prisma client; nothing connects until the first query. */
function openDatabase(options: DatabaseCompositionOptions): Database {
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

function buildVerifyOrder(prisma: PrismaClient): VerifyOrder {
  return createVerifyOrder({ inventoryReader: createPrismaInventoryReader(prisma) });
}

function buildSubmitOrder(
  prisma: PrismaClient,
  options: SubmitOrderCompositionOptions,
): SubmitOrder {
  const realStore = createPrismaSubmissionStore(prisma, options.submissionStore);
  const store = options.decorateSubmissionStore?.(realStore) ?? realStore;
  return createSubmitOrder({
    store,
    ...(options.maxSubmissionAttempts === undefined
      ? {}
      : { maxAttempts: options.maxSubmissionAttempts }),
  });
}

function withLogger(logger: Logger | undefined): { logger?: Logger } {
  return logger === undefined ? {} : { logger };
}

/** `GET /health` alone: no configuration, no database; `close()` is a no-op. */
export function composeHealthApplication(
  options: { readonly logger?: Logger } = {},
): ComposedApplication {
  return { app: createHealthApp(options), close: async () => undefined };
}

/** `POST /orders/verify` alone: pool, Prisma, inventory reader. */
export function composeVerifyOrderApplication(
  options: VerifyOrderCompositionOptions,
): ComposedApplication {
  const database = openDatabase(options);
  try {
    const verifyOrder = buildVerifyOrder(database.prisma);
    return {
      app: createVerifyOrderApp({ verifyOrder, ...withLogger(options.logger) }),
      close: database.close,
    };
  } catch (error) {
    // Not awaited: pg connects lazily, so nothing has connected yet.
    void database.close().catch(() => undefined);
    throw error;
  }
}

/** `POST /orders` alone: pool, Prisma, submission store. */
export function composeSubmitOrderApplication(
  options: SubmitOrderCompositionOptions,
): ComposedApplication {
  const database = openDatabase(options);
  try {
    const submitOrder = buildSubmitOrder(database.prisma, options);
    return {
      app: createSubmitOrderApp({ submitOrder, ...withLogger(options.logger) }),
      close: database.close,
    };
  } catch (error) {
    // Not awaited: pg connects lazily, so nothing has connected yet.
    void database.close().catch(() => undefined);
    throw error;
  }
}

/** Every route over one pool, for the local server and documentation routes. */
export function composeApplication(options: CompositionOptions): ComposedApplication {
  const database = openDatabase(options);
  try {
    const app = createApp({
      verifyOrder: buildVerifyOrder(database.prisma),
      submitOrder: buildSubmitOrder(database.prisma, options),
      ...withLogger(options.logger),
    });
    return { app, close: database.close };
  } catch (error) {
    // Not awaited: pg connects lazily, so nothing has connected yet.
    void database.close().catch(() => undefined);
    throw error;
  }
}
