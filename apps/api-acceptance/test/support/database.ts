/**
 * Direct PostgreSQL access for arranging and inspecting acceptance scenarios.
 *
 * The suite drives the API over HTTP, but some scenarios need stock set to an
 * exact shape beforehand, or need to prove that a rejected request wrote
 * nothing at all. Those go through this module, which talks to the acceptance
 * database with pg only — never through the application's own code.
 *
 * Provisioning (creating and migrating the database) belongs to the global
 * setup; one database is shared by the whole run and {@link resetDatabase}
 * returns it to the PRD seed state between tests.
 *
 * @module
 */

import { createDatabasePool, seedWarehouses } from "@scos/persistence";
import { Client, type Pool } from "pg";

/** Opens the suite's own pool on the acceptance database (the app has its own). */
export function openPool(databaseUrl: string): Pool {
  return createDatabasePool(databaseUrl);
}

/** Deletes every Order and allocation and reseeds the six PRD warehouses. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM order_allocations");
  await pool.query("DELETE FROM orders");
  await pool.query("DELETE FROM warehouses");
  await seedWarehouses(pool);
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export interface WarehouseRow {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  stock: number;
  created_at: Date;
  updated_at: Date;
  xmin: string;
  ctid: string;
}

export interface OrderRow {
  id: string;
  order_number: string;
  submission_key: string;
  quantity: number;
  created_at: Date;
  updated_at: Date;
  xmin: string;
  ctid: string;
}

export interface AllocationRow {
  order_id: string;
  warehouse_id: string;
  quantity: number;
  created_at: Date;
  updated_at: Date;
  xmin: string;
}

export interface PersistedState {
  warehouses: WarehouseRow[];
  orders: OrderRow[];
  allocations: AllocationRow[];
}

/**
 * Every warehouse, Order and allocation row with its timestamps and row
 * version (`xmin`, `ctid`). Two equal results prove nothing was rewritten,
 * not even with identical values.
 */
export async function readState(pool: Pool): Promise<PersistedState> {
  const warehouses = await pool.query<WarehouseRow>(
    `SELECT id::text AS id, name, latitude, longitude, stock, created_at, updated_at,
            xmin::text AS xmin, ctid::text AS ctid
     FROM warehouses ORDER BY id`,
  );
  const orders = await pool.query<OrderRow>(
    `SELECT id::text AS id, order_number, submission_key, quantity, created_at, updated_at,
            xmin::text AS xmin, ctid::text AS ctid
     FROM orders ORDER BY id`,
  );
  const allocations = await pool.query<AllocationRow>(
    `SELECT order_id::text AS order_id, warehouse_id::text AS warehouse_id, quantity,
            created_at, updated_at, xmin::text AS xmin
     FROM order_allocations ORDER BY id`,
  );
  return { warehouses: warehouses.rows, orders: orders.rows, allocations: allocations.rows };
}

export async function stockById(pool: Pool): Promise<Record<string, number>> {
  const rows = await pool.query<{ id: string; stock: number }>(
    "SELECT id::text AS id, stock FROM warehouses ORDER BY id",
  );
  return Object.fromEntries(rows.rows.map(({ id, stock }) => [id, stock]));
}

export async function setStock(pool: Pool, stock: Readonly<Record<string, number>>): Promise<void> {
  for (const [id, value] of Object.entries(stock)) {
    const result = await pool.query("UPDATE warehouses SET stock = $2 WHERE id = $1::uuid", [
      id,
      value,
    ]);
    if (result.rowCount !== 1) {
      throw new Error(`No warehouse ${id}`);
    }
  }
}

/** Sets every warehouse's stock at once (unlisted ones to `others`). */
export async function setAllStock(
  pool: Pool,
  stock: Readonly<Record<string, number>>,
  others = 0,
): Promise<void> {
  await pool.query("UPDATE warehouses SET stock = $1", [others]);
  await setStock(pool, stock);
}

/**
 * Opens a separate connection and locks every warehouse row, as a submission
 * does, until `release()` commits. Requests issued meanwhile queue on the
 * locks, which gives tests controlled overlap.
 */
export async function holdWarehouseLocks(url: string): Promise<{ release(): Promise<void> }> {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM warehouses ORDER BY id FOR UPDATE");
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("COMMIT");
      } finally {
        await client.end();
      }
    },
  };
}

/** Number of other backends in this database currently waiting on a lock. */
export async function lockWaiters(pool: Pool): Promise<number> {
  const result = await pool.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'
       AND pid <> pg_backend_pid()`,
  );
  return result.rows[0]?.waiting ?? 0;
}

/** Polls until `count` backends are waiting on locks (or fails after timeout). */
export async function waitForLockWaiters(pool: Pool, count: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await lockWaiters(pool);
    if (waiting >= count) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Only ${waiting} of ${count} requests are waiting on the warehouse locks`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
