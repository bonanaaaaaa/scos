/**
 * The Cloudflare Workers composition: all three endpoints and the
 * documentation routes (`createApp`), with the same use cases, persistence
 * adapters and telemetry decorators as the Node composition, over Prisma 7
 * and `@prisma/adapter-pg` on the Hyperdrive binding's connection string.
 *
 * Built once per isolate: the app, its routes, the OpenAPI document and the
 * telemetry wiring. Database clients are not: as #28 specifies and
 * Cloudflare's Hyperdrive connection-lifecycle guidance requires, each
 * request that touches the database creates its own Prisma client over its
 * own pg pool (at most {@link WORKER_REQUEST_MAX_CONNECTIONS} connections)
 * inside the handler, opened on first use and released under
 * `ctx.waitUntil` after the response. Workers forbid I/O objects (sockets)
 * created for one request from being used by another, and Hyperdrive pools
 * the real database connections, so connecting to it is cheap. Supporting
 * evidence: one Prisma client shared by the isolate is unsafe even over
 * per-request pools, because Prisma batches concurrent calls, so one
 * request's query can run on another request's connection (a spike hung
 * under concurrent requests). `GET /health` and rejected requests open
 * nothing.
 *
 * Runtime-specific: `node:async_hooks` (`nodejs_compat`) carries the request's
 * database to the use cases, which the app builds once.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { SubmitOrder, VerifyOrder } from "@scos/core";
import { createDatabasePool, createPrismaClient } from "@scos/persistence";
import type { Context, MiddlewareHandler } from "hono";

import { createApp } from "#app";
import { buildSubmitOrder } from "#endpoints/submit-order/composition";
import { buildVerifyOrder } from "#endpoints/verify-order/composition";
import { createEndpointApp } from "#http/endpoint-app";
import { type Logger, defaultLogger } from "#http/logger";
import { MESSAGES } from "#http/messages";
import type { Telemetry } from "#telemetry/telemetry";
import type { ComposedApplication } from "#composition/composed-application";
import { databasePoolTimeouts, withHttpTelemetry } from "#composition/database";

/**
 * pg pool size per request. A request's queries run one after another (the
 * unlocked lookup, then one transaction at a time), so it opens one
 * connection; the second is headroom, well under Workers' six simultaneous
 * open connections per invocation.
 */
export const WORKER_REQUEST_MAX_CONNECTIONS = 2;

export interface WorkerCompositionOptions {
  /** The Hyperdrive binding's connection string, validated (`parseWorkerConfig`). */
  readonly databaseUrl: string;
  readonly logger?: Logger;
  /** Traces and meters the app, use cases and persistence ports. */
  readonly telemetry?: Telemetry;
  /** Limit for opening a connection to Hyperdrive; the database default otherwise. */
  readonly connectionTimeoutMs?: number;
}

interface UseCases {
  readonly verifyOrder: VerifyOrder;
  readonly submitOrder: SubmitOrder;
}

/** One request's database: opened on first use, closed after the response. */
class RequestDatabase {
  readonly #options: WorkerCompositionOptions;
  #opened: { close(): Promise<void>; readonly useCases: UseCases } | undefined;

  constructor(options: WorkerCompositionOptions) {
    this.#options = options;
  }

  useCases(): UseCases {
    if (this.#opened === undefined) {
      const options = this.#options;
      const pool = createDatabasePool(options.databaseUrl, {
        ...databasePoolTimeouts(options.connectionTimeoutMs),
        max: WORKER_REQUEST_MAX_CONNECTIONS,
      });
      const prisma = createPrismaClient(pool);
      this.#opened = {
        // Disconnect Prisma first, then end the pool it borrows.
        close: async () => {
          try {
            await prisma.$disconnect();
          } finally {
            await pool.end();
          }
        },
        useCases: {
          verifyOrder: buildVerifyOrder(prisma, options.telemetry),
          submitOrder: buildSubmitOrder(prisma, {
            databaseUrl: options.databaseUrl,
            ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
          }),
        },
      };
    }
    return this.#opened.useCases;
  }

  /** Releases what this request opened; never rejects. */
  async close(): Promise<void> {
    await this.#opened?.close().catch(() => undefined);
  }
}

const requests = new AsyncLocalStorage<RequestDatabase>();

function current(): UseCases {
  const database = requests.getStore();
  if (database === undefined) {
    throw new Error("No request database: the request did not pass through the Worker app.");
  }
  return database.useCases();
}

/** `ctx.waitUntil` when the request came through a Worker `fetch` handler. */
function waitUntil(c: Context, work: Promise<unknown>): void {
  let executionContext: Context["executionCtx"] | undefined;
  try {
    executionContext = c.executionCtx;
  } catch {
    // `app.request()` in tests has no execution context; `work` still runs.
  }
  executionContext?.waitUntil(work);
}

/** Gives each request its own {@link RequestDatabase} and closes it afterwards. */
function requestDatabase(options: WorkerCompositionOptions): MiddlewareHandler {
  return async (c, next) => {
    const database = new RequestDatabase(options);
    try {
      await requests.run(database, next);
    } finally {
      // After the response is produced; not awaited on the response path.
      waitUntil(c, database.close());
    }
  };
}

/**
 * The Worker's app: every route of `createApp`, the per-request database
 * scope, and (with `telemetry`) the HTTP server middleware, once.
 */
export function composeWorkerApplication(options: WorkerCompositionOptions): ComposedApplication {
  // Validate eagerly, as the Node composition does when it opens its pool.
  databasePoolTimeouts(options.connectionTimeoutMs);
  const logger = options.logger ?? defaultLogger;
  const app = createEndpointApp(logger, () => MESSAGES.internal);
  app.use("*", requestDatabase(options));
  app.route(
    "/",
    createApp({
      verifyOrder: (request) => current().verifyOrder(request),
      submitOrder: (input) => current().submitOrder(input),
      logger,
    }),
  );
  return {
    app: withHttpTelemetry(app, options),
    // Nothing is held across requests.
    close: async () => undefined,
  };
}
