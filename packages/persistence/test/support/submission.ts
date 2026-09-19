import {
  type SubmissionStore,
  type SubmitOrder,
  type SubmitOrderDependencies,
  createSubmitOrder,
} from "@scos/core";
import { Client, type Pool } from "pg";

import { createDatabasePool } from "../../src/database";
import { createPrismaClient, type PrismaClient } from "../../src/prisma";
import { warehouseSeeds } from "../../src/seed";
import {
  type PrismaSubmissionStoreOptions,
  createPrismaSubmissionStore,
} from "../../src/submission-store";

export const warehouseIds = {
  losAngeles: warehouseSeeds[0]!.id,
  newYork: warehouseSeeds[1]!.id,
  saoPaulo: warehouseSeeds[2]!.id,
  paris: warehouseSeeds[3]!.id,
  warsaw: warehouseSeeds[4]!.id,
  hongKong: warehouseSeeds[5]!.id,
} as const;

/** The Los Angeles warehouse's own coordinates: zero shipping distance from it. */
export const losAngeles = { latitude: 33.9425, longitude: -118.408056 } as const;

/**
 * An independent application instance: its own pg pool (so its own
 * connections), Prisma client, store, and SubmitOrder use case. Opening a new
 * actor after closing one simulates a process restart.
 */
export interface Actor {
  readonly pool: Pool;
  readonly prisma: PrismaClient;
  readonly store: SubmissionStore;
  readonly submit: SubmitOrder;
  close(): Promise<void>;
}

export interface ActorOptions {
  readonly store?: PrismaSubmissionStoreOptions;
  /** Wraps the real Prisma store, for example to count or intercept calls. */
  readonly wrapStore?: (store: SubmissionStore) => SubmissionStore;
  readonly useCase?: Omit<SubmitOrderDependencies, "store">;
}

export function openActor(url: string, options: ActorOptions = {}): Actor {
  const pool = createDatabasePool(url);
  const prisma = createPrismaClient(pool);
  const real = createPrismaSubmissionStore(prisma, options.store);
  const store = options.wrapStore?.(real) ?? real;
  const submit = createSubmitOrder({ ...options.useCase, store });
  return {
    pool,
    prisma,
    store,
    submit,
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

/** Opens `count` actors and closes them all after `run`, even on failure. */
export async function withActors<T>(
  url: string,
  count: number,
  run: (actors: readonly Actor[]) => Promise<T>,
  options: (index: number) => ActorOptions = () => ({}),
): Promise<T> {
  const actors = Array.from({ length: count }, (_, index) => openActor(url, options(index)));
  try {
    return await run(actors);
  } finally {
    await Promise.all(actors.map((actor) => actor.close()));
  }
}

/** Deletes every Order and restores the six seeded warehouses' stock. */
export async function resetOrdering(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE order_allocations, orders");
  for (const seed of warehouseSeeds) {
    await pool.query("UPDATE warehouses SET stock = $2 WHERE id = $1", [seed.id, seed.stock]);
  }
}

/** Sets stock per warehouse; warehouses not listed get zero. */
export async function setStock(
  pool: Pool,
  stock: Partial<Record<keyof typeof warehouseIds, number>>,
): Promise<void> {
  for (const [name, id] of Object.entries(warehouseIds)) {
    await pool.query("UPDATE warehouses SET stock = $2 WHERE id = $1", [
      id,
      stock[name as keyof typeof warehouseIds] ?? 0,
    ]);
  }
}

export interface OrderingState {
  readonly orders: readonly {
    readonly id: string;
    readonly orderNumber: string;
    readonly submissionKey: string;
    readonly quantity: number;
    readonly latitude: number;
    readonly longitude: number;
    readonly unitPrice: string;
    readonly discountRate: string;
    readonly discountAmount: string;
    readonly shippingCost: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
  readonly allocations: readonly {
    readonly id: string;
    readonly orderId: string;
    readonly warehouseId: string;
    readonly quantity: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
  /** Stock by warehouse id, in id order. */
  readonly stock: Readonly<Record<string, number>>;
  /** Warehouse updated_at by id, as exact PostgreSQL text. */
  readonly warehouseUpdatedAt: Readonly<Record<string, string>>;
}

/** Reads every row the submission path writes. Timestamps are exact text. */
export async function readOrderingState(pool: Pool): Promise<OrderingState> {
  const orders = await pool.query<OrderingState["orders"][number]>(
    `SELECT id::text, order_number AS "orderNumber", submission_key AS "submissionKey", quantity,
            destination_latitude AS latitude, destination_longitude AS longitude,
            unit_price::text AS "unitPrice", discount_rate::text AS "discountRate",
            discount_amount::text AS "discountAmount", shipping_cost::text AS "shippingCost",
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM orders ORDER BY id`,
  );
  const allocations = await pool.query<OrderingState["allocations"][number]>(
    `SELECT id::text, order_id::text AS "orderId", warehouse_id::text AS "warehouseId", quantity,
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM order_allocations ORDER BY id`,
  );
  const warehouses = await pool.query<{ id: string; stock: number; updatedAt: string }>(
    `SELECT id::text, stock, updated_at::text AS "updatedAt" FROM warehouses ORDER BY id`,
  );
  return {
    orders: orders.rows,
    allocations: allocations.rows,
    stock: Object.fromEntries(warehouses.rows.map((row) => [row.id, row.stock])),
    warehouseUpdatedAt: Object.fromEntries(warehouses.rows.map((row) => [row.id, row.updatedAt])),
  };
}

/**
 * Holds `FOR UPDATE` locks on every warehouse row from a separate pg Client,
 * so submissions started meanwhile queue on them. release() rolls back.
 */
export async function holdWarehouseLocks(url: string): Promise<{ release(): Promise<void> }> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM warehouses ORDER BY id FOR UPDATE");
  } catch (error) {
    await client.end();
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
}

/** Backends of this database waiting on a heavyweight (row/tuple) lock. */
export async function countLockWaiters(pool: Pool): Promise<number> {
  const result = await pool.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting
     FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
  );
  return result.rows[0]?.waiting ?? 0;
}

/**
 * Waits until at least `count` backends are blocked on locks, proving the
 * concurrent submissions really overlap, rather than relying on timing.
 */
export async function waitForLockWaiters(pool: Pool, count: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let waiting = await countLockWaiters(pool);
  while (waiting < count) {
    if (Date.now() > deadline) {
      throw new Error(`Only ${waiting} of ${count} submissions reached the warehouse locks`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    waiting = await countLockWaiters(pool);
  }
  return waiting;
}

/**
 * Installs a test-only trigger that raises an exception. The function body is
 * PL/pgSQL; `when` optionally guards the RAISE. Returns a function that drops
 * the trigger and its function.
 */
export async function installFailingTrigger(
  pool: Pool,
  options: {
    readonly name: string;
    readonly timing: "BEFORE" | "AFTER";
    readonly event: "INSERT" | "UPDATE";
    readonly table: "orders" | "order_allocations" | "warehouses";
    readonly sqlState?: string;
    /** Makes it a deferred constraint trigger, which fires at COMMIT. */
    readonly deferred?: boolean;
    readonly when?: string;
  },
): Promise<() => Promise<void>> {
  const { name, timing, event, table, sqlState = "P0001", deferred = false } = options;
  const guard = options.when ?? "true";
  await pool.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF ${guard} THEN
         RAISE EXCEPTION 'injected failure ${name}' USING ERRCODE = '${sqlState}';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await pool.query(
    deferred
      ? `CREATE CONSTRAINT TRIGGER ${name} AFTER ${event} ON ${table}
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`
      : `CREATE TRIGGER ${name} ${timing} ${event} ON ${table}
         FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  return async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}

/** Counts runInTransaction calls and records how each attempt ended. */
export function countingStore(store: SubmissionStore): {
  readonly store: SubmissionStore;
  readonly attempts: unknown[];
} {
  const attempts: unknown[] = [];
  return {
    attempts,
    store: {
      findOrderBySubmissionKey: (key) => store.findOrderBySubmissionKey(key),
      async runInTransaction(work) {
        try {
          const result = await store.runInTransaction(work);
          attempts.push("resolved");
          return result;
        } catch (error) {
          attempts.push(error);
          throw error;
        }
      },
    },
  };
}
