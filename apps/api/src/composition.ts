/**
 * Composition root: wires the PostgreSQL adapters into the core use cases and
 * the use cases into the Hono app.
 *
 * pool -> Prisma client -> inventory reader + submission store -> use cases -> app
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

import { type SubmissionStore, createSubmitOrder, createVerifyOrder } from "@scos/core";
import {
  type DatabasePoolOptions,
  type PrismaSubmissionStoreOptions,
  createDatabasePool,
  createPrismaClient,
  createPrismaInventoryReader,
  createPrismaSubmissionStore,
} from "@scos/persistence";
import type { Hono } from "hono";

import { type Logger, createApp } from "./app";

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

export interface CompositionOptions {
  /** A validated PostgreSQL connection string (see `config.ts`). */
  readonly databaseUrl: string;
  readonly logger?: Logger;
  /** Transaction timeouts for submissions; persistence defaults apply otherwise. */
  readonly submissionStore?: PrismaSubmissionStoreOptions;
  /** Limit for acquiring or opening a connection; {@link DEFAULT_CONNECTION_TIMEOUT_MS}. */
  readonly connectionTimeoutMs?: number;
  /** Total SubmitOrder attempts for transient failures; core default otherwise. */
  readonly maxSubmissionAttempts?: number;
  /**
   * Wraps the real submission store. Tests use it to inject failures at a
   * given stage while every request still goes through the composed app.
   */
  readonly decorateSubmissionStore?: (store: SubmissionStore) => SubmissionStore;
}

export interface ComposedApplication {
  readonly app: Hono;
  /** Disconnects Prisma, then ends the pool. Safe to call more than once. */
  close(): Promise<void>;
}

export function composeApplication(options: CompositionOptions): ComposedApplication {
  const pool = createDatabasePool(
    options.databaseUrl,
    databasePoolTimeouts(options.connectionTimeoutMs),
  );
  const prisma = createPrismaClient(pool);

  const realStore = createPrismaSubmissionStore(prisma, options.submissionStore);
  const store = options.decorateSubmissionStore?.(realStore) ?? realStore;

  const verifyOrder = createVerifyOrder({ inventoryReader: createPrismaInventoryReader(prisma) });
  const submitOrder = createSubmitOrder({
    store,
    ...(options.maxSubmissionAttempts === undefined
      ? {}
      : { maxAttempts: options.maxSubmissionAttempts }),
  });

  const app = createApp({
    verifyOrder,
    submitOrder,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  let closing: Promise<void> | undefined;
  return {
    app,
    close() {
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
