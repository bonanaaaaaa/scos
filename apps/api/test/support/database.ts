/**
 * Isolated PostgreSQL databases for the API's full-stack tests.
 *
 * Mirrors packages/persistence/test/support/database.ts: each test file gets a
 * uniquely named database beside `scos_test`, migrated with the persistence
 * package's own Prisma CLI and prisma.config.ts, then seeded with the six PRD
 * warehouses. DATABASE_TEST_URL is required; without it the tests fail rather
 * than skip.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createDatabasePool, seedWarehouses } from "@scos/persistence";
import { Client, type Pool } from "pg";

const execFileAsync = promisify(execFile);

/** The persistence workspace package (migrations, prisma.config.ts, CLI). */
const persistenceDirectory = realpathSync(
  fileURLToPath(new URL("../../node_modules/@scos/persistence/", import.meta.url)),
);
const prismaCli = `${persistenceDirectory}/node_modules/.bin/prisma`;

/**
 * Returns DATABASE_TEST_URL after the isolation guards used by the persistence
 * tests: it must name the dedicated scos_test database and differ from
 * DATABASE_URL.
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

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  /** A separate pool for assertions and setup; the app under test has its own. */
  readonly pool: Pool;
  /** Deletes every Order and reseeds the six warehouses with PRD stock. */
  reset(): Promise<void>;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const testUrl = requireTestDatabaseUrl();
  const name = `scos_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(testUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  const admin = adminClient(testUrl);
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

  const dropDatabase = async () => {
    const cleanup = adminClient(testUrl);
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };

  try {
    await execFileAsync(prismaCli, ["migrate", "deploy"], {
      cwd: persistenceDirectory,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60_000,
    });
  } catch (error) {
    await dropDatabase();
    throw error;
  }

  const pool = createDatabasePool(databaseUrl);
  const reset = async () => {
    await pool.query("DELETE FROM order_allocations");
    await pool.query("DELETE FROM orders");
    await pool.query("DELETE FROM warehouses");
    await seedWarehouses(pool);
  };

  return {
    name,
    url: databaseUrl,
    pool,
    reset,
    drop: async () => {
      try {
        await pool.end();
      } finally {
        await dropDatabase();
      }
    },
  };
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
