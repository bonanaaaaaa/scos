import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createPrismaInventoryReader } from "#inventory-reader";
import { seedWarehouses, warehouseSeeds } from "#seed";
import {
  createMigratedDatabase,
  type MigratedDatabase,
  readPersistedState,
} from "#test/support/database";

// Seeded warehouse IDs (see src/seed.ts).
const PARIS = "01996000-0000-7000-8000-000000000004";
const WARSAW = "01996000-0000-7000-8000-000000000005";

// The six PRD stock levels in ID order.
const seededStock = [355, 578, 265, 694, 245, 419];

let db: MigratedDatabase;

function readSnapshot() {
  return createPrismaInventoryReader(db.prisma).readInventorySnapshot();
}

async function setStock(warehouseId: string, stock: number): Promise<void> {
  const result = await db.pool.query("UPDATE warehouses SET stock = $2 WHERE id = $1::uuid", [
    warehouseId,
    stock,
  ]);
  expect(result.rowCount).toBe(1);
}

// The adapter's side of core's InventoryReader contract: coherent, complete,
// read-only and current. What VerifyOrder makes of a snapshot is tested in
// packages/core with a fake port; the full composition is tested with the API.
describe("PostgreSQL inventory reader", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = await createMigratedDatabase();
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.pool.query("DELETE FROM warehouses");
    expect(await seedWarehouses(db.pool)).toStrictEqual({ inserted: 6, existing: 0 });
  });

  test("the snapshot is every warehouse's current stock in ID order", async () => {
    await setStock(WARSAW, 0);
    const rows = await db.pool.query<{
      id: string;
      name: string;
      latitude: number;
      longitude: number;
      stock: number;
    }>("SELECT id::text AS id, name, latitude, longitude, stock FROM warehouses ORDER BY id");

    const snapshot = await readSnapshot();

    expect(snapshot).toHaveLength(6);
    expect(snapshot).toStrictEqual(
      rows.rows.map(({ id, name, latitude, longitude, stock }) => ({
        warehouseId: id,
        warehouseName: name,
        latitude,
        longitude,
        available: stock,
      })),
    );
    expect(snapshot.map((warehouse) => warehouse.warehouseId)).toStrictEqual(
      warehouseSeeds.map((seed) => seed.id),
    );
    // A warehouse with no stock still appears.
    expect(snapshot.map((warehouse) => warehouse.available)).toStrictEqual([
      355, 578, 265, 694, 0, 419,
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  // An estimate is advisory and computed from a fresh snapshot, so the name is
  // read live beside the stock: a renamed warehouse is estimated under its
  // current name.
  test("the snapshot carries each warehouse's current name in ID order", async () => {
    expect((await readSnapshot()).map((warehouse) => warehouse.warehouseName)).toStrictEqual([
      "Los Angeles",
      "New York",
      "São Paulo",
      "Paris",
      "Warsaw",
      "Hong Kong",
    ]);
    expect((await readSnapshot()).map((warehouse) => warehouse.warehouseName)).toStrictEqual(
      warehouseSeeds.map((seed) => seed.name),
    );

    const renamed = await db.pool.query("UPDATE warehouses SET name = $2 WHERE id = $1::uuid", [
      PARIS,
      "Paris Charles de Gaulle",
    ]);
    expect(renamed.rowCount).toBe(1);
    expect((await readSnapshot()).map((warehouse) => warehouse.warehouseName)).toStrictEqual([
      "Los Angeles",
      "New York",
      "São Paulo",
      "Paris Charles de Gaulle",
      "Warsaw",
      "Hong Kong",
    ]);
  });

  test("the state comparison exposes a rewrite that leaves every stock value the same", async () => {
    const before = await readPersistedState(db.pool);

    await db.pool.query("UPDATE warehouses SET stock = stock WHERE id = $1::uuid", [PARIS]);

    const after = await readPersistedState(db.pool);
    const stockOf = (state: typeof before) => state.warehouses.map((row) => row.stock);
    expect(stockOf(after)).toStrictEqual(stockOf(before));
    expect(after).not.toStrictEqual(before);
    const paris = (state: typeof before) => state.warehouses.find((row) => row.id === PARIS);
    expect(paris(after)?.xmin).not.toBe(paris(before)?.xmin);
    expect(paris(after)?.created_at).toStrictEqual(paris(before)?.created_at);
  });

  test("reading writes nothing: no row version, timestamp or Order table changes", async () => {
    const before = await readPersistedState(db.pool);
    expect(before.warehouses).toHaveLength(6);
    expect(before.counts).toStrictEqual({ orders: 0, order_allocations: 0 });

    await readSnapshot();
    await readSnapshot();

    expect(await readPersistedState(db.pool)).toStrictEqual(before);
  });

  test("each read observes committed stock changes; nothing is cached", async () => {
    const reader = createPrismaInventoryReader(db.prisma);
    const available = async () =>
      (await reader.readInventorySnapshot()).map((warehouse) => warehouse.available);

    expect(await available()).toStrictEqual(seededStock);

    await setStock(PARIS, 1);
    expect(await available()).toStrictEqual([355, 578, 265, 1, 245, 419]);

    await db.pool.query("UPDATE warehouses SET stock = 0");
    expect(await available()).toStrictEqual([0, 0, 0, 0, 0, 0]);
  });

  test("reading takes no row lock and sees only committed stock", async () => {
    const before = await readPersistedState(db.pool);
    const submission = await db.pool.connect();
    let blockedTimer: NodeJS.Timeout | undefined;
    try {
      // A concurrent transaction, as submission will do, locks every warehouse
      // row and deducts stock without committing.
      await submission.query("BEGIN");
      await submission.query("SELECT id FROM warehouses ORDER BY id FOR UPDATE");
      await submission.query("UPDATE warehouses SET stock = 0");

      // A locking read would wait behind that transaction indefinitely (the
      // pool sets no statement timeout), so the wait is bounded here: a
      // regression fails fast and the rollback below still runs. The plain
      // snapshot read returns at once with the committed stock.
      const snapshot = await Promise.race([
        readSnapshot(),
        new Promise<never>((_, reject) => {
          blockedTimer = setTimeout(
            () => reject(new Error("the inventory read blocked behind a row lock")),
            5_000,
          );
        }),
      ]);
      expect(snapshot.map((warehouse) => warehouse.available)).toStrictEqual(seededStock);
    } finally {
      clearTimeout(blockedTimer);
      await submission.query("ROLLBACK");
      submission.release();
    }
    expect(await readPersistedState(db.pool)).toStrictEqual(before);
  });
});
