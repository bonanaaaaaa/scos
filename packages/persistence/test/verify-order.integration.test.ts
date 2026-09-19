import { createVerifyOrder, type OrderEstimate, orderRequestSchema } from "@scos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createPrismaInventoryReader } from "../src/inventory-reader";
import { seedWarehouses, warehouseSeeds } from "../src/seed";
import { createMigratedDatabase, type MigratedDatabase } from "./support/database";

// Seeded warehouse IDs, in ID order (see src/seed.ts).
const PARIS = "01996000-0000-7000-8000-000000000004";
const WARSAW = "01996000-0000-7000-8000-000000000005";
const HONG_KONG = "01996000-0000-7000-8000-000000000006";

const BANGKOK = { latitude: 13.75, longitude: 100.5 };
const SYDNEY = { latitude: -33.8688, longitude: 151.2093 };

// 500 units to Bangkok: Hong Kong 419 x 1706.375 km + Warsaw 81 x 8093.304 km
// at 0.00365 $/unit/km = 5002.43, under the limit of 15% x 60000.00 = 9000.00.
const validRequest = orderRequestSchema.parse({ quantity: 500, ...BANGKOK });
// 1 unit to Sydney: nearest stock is Hong Kong at 7388.905 km = 26.97, over the
// limit of 15% x 150.00 = 22.50.
const excessiveShippingRequest = orderRequestSchema.parse({ quantity: 1, ...SYDNEY });
// One more than the 2556 units seeded across the six warehouses.
const insufficientStockRequest = orderRequestSchema.parse({ quantity: 2557, ...BANGKOK });

let db: MigratedDatabase;

const summarise = (estimate: OrderEstimate) => ({
  valid: estimate.valid,
  reason: estimate.reason,
  quantity: estimate.quantity,
  destination: estimate.destination,
  merchandiseSubtotal: estimate.merchandiseSubtotal.toString(),
  discountRate: estimate.discountRate,
  discountAmount: estimate.discountAmount.toString(),
  discountedMerchandiseTotal: estimate.discountedMerchandiseTotal.toString(),
  shippingCost: estimate.shippingCost?.toString() ?? null,
  orderTotal: estimate.orderTotal?.toString() ?? null,
  allocations: estimate.allocations.map(({ warehouseId, quantity }) => [warehouseId, quantity]),
});

interface WarehouseStateRow {
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

/**
 * Everything verification could have touched. `xmin` and `ctid` change whenever
 * a row version is rewritten, so they expose even an UPDATE that sets the same
 * values (which the update trigger would otherwise also show in `updated_at`).
 */
async function readPersistedState() {
  const warehouses = await db.pool.query<WarehouseStateRow>(
    `SELECT id, name, latitude, longitude, stock, created_at, updated_at,
            xmin::text AS xmin, ctid::text AS ctid
     FROM warehouses ORDER BY id`,
  );
  const counts = await db.pool.query<{ orders: number; order_allocations: number }>(
    `SELECT (SELECT count(*)::int FROM orders) AS orders,
            (SELECT count(*)::int FROM order_allocations) AS order_allocations`,
  );
  return { warehouses: warehouses.rows, counts: counts.rows[0] };
}

function verifyOrder(request: typeof validRequest): Promise<OrderEstimate> {
  return createVerifyOrder({ inventoryReader: createPrismaInventoryReader(db.prisma) })(request);
}

/** Verifies and asserts that no persisted state changed, whatever the outcome. */
async function verifyLeavingStateUnchanged(request: typeof validRequest): Promise<OrderEstimate> {
  const before = await readPersistedState();
  expect(before.warehouses).toHaveLength(6);
  expect(before.counts).toStrictEqual({ orders: 0, order_allocations: 0 });

  const estimate = await verifyOrder(request);

  expect(await readPersistedState()).toStrictEqual(before);
  return estimate;
}

async function setStock(warehouseId: string, stock: number): Promise<void> {
  const result = await db.pool.query("UPDATE warehouses SET stock = $2 WHERE id = $1::uuid", [
    warehouseId,
    stock,
  ]);
  expect(result.rowCount).toBe(1);
}

describe("advisory verification against PostgreSQL inventory", { timeout: 30_000 }, () => {
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

  test("the inventory snapshot is every warehouse's current stock in ID order", async () => {
    await setStock(WARSAW, 0);
    const rows = await db.pool.query<{
      id: string;
      latitude: number;
      longitude: number;
      stock: number;
    }>("SELECT id::text AS id, latitude, longitude, stock FROM warehouses ORDER BY id");

    const snapshot = await createPrismaInventoryReader(db.prisma).readInventorySnapshot();

    expect(snapshot).toHaveLength(6);
    expect(snapshot).toStrictEqual(
      rows.rows.map(({ id, latitude, longitude, stock }) => ({
        warehouseId: id,
        latitude,
        longitude,
        available: stock,
      })),
    );
    expect(snapshot.map((warehouse) => warehouse.warehouseId)).toStrictEqual(
      warehouseSeeds.map((seed) => seed.id),
    );
    expect(snapshot.map((warehouse) => warehouse.available)).toStrictEqual([
      355, 578, 265, 694, 0, 419,
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test("the state comparison exposes a rewrite that leaves every stock value the same", async () => {
    const before = await readPersistedState();

    await db.pool.query("UPDATE warehouses SET stock = stock WHERE id = $1::uuid", [PARIS]);

    const after = await readPersistedState();
    const stockOf = (state: typeof before) => state.warehouses.map((row) => row.stock);
    expect(stockOf(after)).toStrictEqual(stockOf(before));
    expect(after).not.toStrictEqual(before);
    const paris = (state: typeof before) => state.warehouses.find((row) => row.id === PARIS);
    expect(paris(after)?.xmin).not.toBe(paris(before)?.xmin);
    expect(paris(after)?.created_at).toStrictEqual(paris(before)?.created_at);
  });

  test("a valid estimate has exact amounts and changes nothing", async () => {
    const estimate = await verifyLeavingStateUnchanged(validRequest);

    expect(summarise(estimate)).toStrictEqual({
      valid: true,
      reason: null,
      quantity: 500,
      destination: BANGKOK,
      merchandiseSubtotal: "75000.00",
      discountRate: "0.20",
      discountAmount: "15000.00",
      discountedMerchandiseTotal: "60000.00",
      shippingCost: "5002.43",
      orderTotal: "65002.43",
      allocations: [
        [HONG_KONG, 419],
        [WARSAW, 81],
      ],
    });
  });

  test("an excessive-shipping estimate keeps its amounts and changes nothing", async () => {
    const estimate = await verifyLeavingStateUnchanged(excessiveShippingRequest);

    expect(summarise(estimate)).toStrictEqual({
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      quantity: 1,
      destination: SYDNEY,
      merchandiseSubtotal: "150.00",
      discountRate: "0.00",
      discountAmount: "0.00",
      discountedMerchandiseTotal: "150.00",
      shippingCost: "26.97",
      orderTotal: "176.97",
      allocations: [[HONG_KONG, 1]],
    });
  });

  test("an insufficient-stock estimate has null shipping and total and changes nothing", async () => {
    const estimate = await verifyLeavingStateUnchanged(insufficientStockRequest);

    expect(summarise(estimate)).toStrictEqual({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      quantity: 2557,
      destination: BANGKOK,
      merchandiseSubtotal: "383550.00",
      discountRate: "0.20",
      discountAmount: "76710.00",
      discountedMerchandiseTotal: "306840.00",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });
    expect(estimate.shippingCost).toBeNull();
    expect(estimate.orderTotal).toBeNull();
  });

  test("the whole seeded inventory can be estimated without reserving any of it", async () => {
    const exact = orderRequestSchema.parse({ quantity: 2556, ...BANGKOK });

    const first = await verifyLeavingStateUnchanged(exact);
    const second = await verifyLeavingStateUnchanged(exact);

    // Had the first verification reserved stock, the second would be insufficient.
    for (const estimate of [first, second]) {
      expect(estimate.reason).not.toBe("INSUFFICIENT_STOCK");
      expect(estimate.allocations.reduce((sum, { quantity }) => sum + quantity, 0)).toBe(2556);
      expect(estimate.allocations).toHaveLength(6);
    }
    expect(summarise(second)).toStrictEqual(summarise(first));
  });

  test("reverification follows stock changes and does not honour an earlier estimate", async () => {
    const first = await verifyLeavingStateUnchanged(validRequest);
    expect(summarise(first)).toMatchObject({
      valid: true,
      shippingCost: "5002.43",
      orderTotal: "65002.43",
    });

    // Another order takes 119 Hong Kong units: the same request now costs more.
    await setStock(HONG_KONG, 300);
    const costlier = await verifyLeavingStateUnchanged(validRequest);
    expect(summarise(costlier)).toMatchObject({
      valid: true,
      reason: null,
      shippingCost: "7776.59",
      orderTotal: "67776.59",
      allocations: [
        [HONG_KONG, 300],
        [WARSAW, 200],
      ],
    });

    // Less again: Paris is needed and shipping passes 15% of 60000.00.
    await setStock(HONG_KONG, 100);
    const excessive = await verifyLeavingStateUnchanged(validRequest);
    expect(summarise(excessive)).toMatchObject({
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      shippingCost: "13192.63",
      orderTotal: "73192.63",
      allocations: [
        [HONG_KONG, 100],
        [WARSAW, 245],
        [PARIS, 155],
      ],
    });

    // Drained to 499 units in total: the request can no longer be fulfilled.
    await db.pool.query("UPDATE warehouses SET stock = 0");
    await setStock(PARIS, 499);
    const insufficient = await verifyLeavingStateUnchanged(validRequest);
    expect(summarise(insufficient)).toMatchObject({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      discountedMerchandiseTotal: "60000.00",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });

    // Replenished by one unit: fulfillable again, entirely from Paris, but
    // 500 x 9425.299 km = 17201.17 is over the limit of 9000.00.
    await setStock(PARIS, 500);
    const replenished = await verifyLeavingStateUnchanged(validRequest);
    expect(summarise(replenished)).toMatchObject({
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      shippingCost: "17201.17",
      orderTotal: "77201.17",
      allocations: [[PARIS, 500]],
    });
  });

  test("verification takes no row lock and sees only committed stock", async () => {
    const before = await readPersistedState();
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
      const estimate = await Promise.race([
        verifyOrder(validRequest),
        new Promise<never>((_, reject) => {
          blockedTimer = setTimeout(
            () => reject(new Error("verification blocked behind a row lock")),
            5_000,
          );
        }),
      ]);
      expect(summarise(estimate)).toMatchObject({
        valid: true,
        shippingCost: "5002.43",
        allocations: [
          [HONG_KONG, 419],
          [WARSAW, 81],
        ],
      });
    } finally {
      clearTimeout(blockedTimer);
      await submission.query("ROLLBACK");
      submission.release();
    }
    expect(await readPersistedState()).toStrictEqual(before);
  });
});
