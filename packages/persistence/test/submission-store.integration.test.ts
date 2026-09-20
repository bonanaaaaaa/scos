import {
  type Order,
  createOrder,
  createSubmitOrder,
  estimateOrder,
  orderRequestSchema,
  submissionKeySchema,
} from "@scos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { seedWarehouses, warehouseSeeds } from "#seed";
import { createPrismaSubmissionStore } from "#submission-store";
import { createMigratedDatabase, type MigratedDatabase } from "#test/support/database";

// Seeded warehouse IDs (see src/seed.ts).
const LOS_ANGELES = "01996000-0000-7000-8000-000000000001";
const NEW_YORK = "01996000-0000-7000-8000-000000000002";

// The Los Angeles warehouse's own coordinates: 400 units draw 355 from Los
// Angeles (all of it) and the remaining 45 from the next nearest, New York, so
// an accepted Order has two allocations with two different names.
const losAngeles = { latitude: 33.9425, longitude: -118.408056 };

let db: MigratedDatabase;
let orderNumbers: number;

function store() {
  return createPrismaSubmissionStore(db.prisma);
}

/** Deterministic order numbers, so a rerun compares like with like. */
function generateOrderNumber(): string {
  orderNumbers += 1;
  return `SO-${String(orderNumbers).padStart(12, "0")}`;
}

/** The Order exactly as the API serializes it into a 201 body. */
function bodyOf(order: Order): unknown {
  return JSON.parse(JSON.stringify(order));
}

interface SerializedBody {
  readonly allocations: readonly { readonly warehouseId: string; readonly quantity: number }[];
}

/**
 * The serialized body with each allocation reduced to the columns actually
 * stored on `order_allocations`. Everything this keeps is a persisted
 * historical fact; only the warehouse name is dropped, because it is resolved
 * through the foreign key rather than stored.
 */
function storedFactsOf(order: Order): unknown {
  const body = bodyOf(order) as SerializedBody;
  return {
    ...body,
    allocations: body.allocations.map(({ warehouseId, quantity }) => ({ warehouseId, quantity })),
  };
}

function allocationNamesOf(order: Order): string[] {
  return order.allocations.map((allocation) => allocation.warehouseName);
}

async function currentName(warehouseId: string): Promise<string> {
  const result = await db.pool.query<{ name: string }>(
    "SELECT name FROM warehouses WHERE id = $1::uuid",
    [warehouseId],
  );
  return result.rows[0]!.name;
}

async function rename(warehouseId: string, name: string): Promise<void> {
  const result = await db.pool.query("UPDATE warehouses SET name = $2 WHERE id = $1::uuid", [
    warehouseId,
    name,
  ]);
  expect(result.rowCount).toBe(1);
}

/** The columns `order_allocations` really holds for an Order, in row order. */
async function storedAllocations(
  orderId: string,
): Promise<{ warehouse_id: string; quantity: number }[]> {
  const result = await db.pool.query<{ warehouse_id: string; quantity: number }>(
    `SELECT warehouse_id::text AS warehouse_id, quantity
     FROM order_allocations WHERE order_id = $1::uuid ORDER BY id`,
    [orderId],
  );
  return result.rows;
}

// The adapter's side of core's SubmissionStore port, against real PostgreSQL:
// the warehouse name is read under the same lock as the stock while the
// estimate is computed, and resolved through the allocation's foreign key when
// an Order is read back. What SubmitOrder makes of the port is tested in
// packages/core with a fake; the full composition is tested with the API.
describe("PostgreSQL submission store", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = await createMigratedDatabase();
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    orderNumbers = 0;
    await db.pool.query("DELETE FROM order_allocations");
    await db.pool.query("DELETE FROM orders");
    await db.pool.query("DELETE FROM warehouses");
    expect(await seedWarehouses(db.pool)).toStrictEqual({ inserted: 6, existing: 0 });
  });

  test("the locked read returns each warehouse's name with its stock in ID order", async () => {
    const snapshot = await store().runInTransaction((tx) => tx.lockInventory());

    expect(snapshot).toStrictEqual(
      warehouseSeeds.map((seed) => ({
        warehouseId: seed.id,
        warehouseName: seed.name,
        latitude: seed.latitude,
        longitude: seed.longitude,
        available: seed.stock,
      })),
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test("a saved Order's allocations carry the names of the warehouses they were planned from", async () => {
    const request = orderRequestSchema.parse({ quantity: 400, ...losAngeles });
    const submissionKey = submissionKeySchema.parse("locked-names");

    const { snapshotNames, saved } = await store().runInTransaction(async (tx) => {
      const inventory = await tx.lockInventory();
      const estimate = estimateOrder(request, inventory);
      if (!estimate.valid) {
        throw new Error(`expected a valid estimate, got ${estimate.reason}`);
      }
      const order = createOrder({
        orderNumber: generateOrderNumber(),
        submissionKey,
        estimate,
      });
      return {
        // The names as the lock query returned them, keyed by warehouse.
        snapshotNames: new Map(
          inventory.map((warehouse) => [warehouse.warehouseId, warehouse.warehouseName]),
        ),
        saved: await tx.saveAcceptedOrder(order),
      };
    });

    expect(saved.allocations.map((allocation) => allocation.warehouseId)).toStrictEqual([
      LOS_ANGELES,
      NEW_YORK,
    ]);
    expect(allocationNamesOf(saved)).toStrictEqual(
      saved.allocations.map((allocation) => snapshotNames.get(allocation.warehouseId)),
    );
    expect(allocationNamesOf(saved)).toStrictEqual(["Los Angeles", "New York"]);
    // The rows themselves hold only the reference and the quantity; the name
    // above was resolved through warehouse_id.
    expect(await storedAllocations(saved.id)).toStrictEqual([
      { warehouse_id: LOS_ANGELES, quantity: 355 },
      { warehouse_id: NEW_YORK, quantity: 45 },
    ]);
  });

  // The deliberate trade of resolving the warehouse name through the foreign
  // key instead of copying it onto every allocation row: the name is a label
  // of the warehouse the allocation still references, so a rename after
  // acceptance shows through in later reads of an Order already returned.
  // Nothing else moves. The amounts are the real historical facts, and they
  // are stored on the Order and untouched by a rename, as is every other
  // persisted column: order number, submission key, quantity, destination, and
  // the allocations' warehouse IDs, quantities and order.
  test("a repeat after a warehouse rename reports the new names and nothing else changes", async () => {
    const submitOrder = createSubmitOrder({ store: store(), generateOrderNumber });
    const submission = { submissionId: "repeat-after-rename", quantity: 400, ...losAngeles };

    const accepted = await submitOrder(submission);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") {
      throw new TypeError(`expected an accepted submission, got ${accepted.kind}`);
    }
    expect(accepted.replayed).toBe(false);
    const firstStoredFacts = storedFactsOf(accepted.order);
    expect(allocationNamesOf(accepted.order)).toStrictEqual(["Los Angeles", "New York"]);

    await rename(LOS_ANGELES, "LAX Fulfilment Center");
    await rename(NEW_YORK, "JFK Fulfilment Center");
    expect(await currentName(LOS_ANGELES)).toBe("LAX Fulfilment Center");
    expect(await currentName(NEW_YORK)).toBe("JFK Fulfilment Center");

    const repeat = await submitOrder(submission);
    expect(repeat.kind).toBe("accepted");
    if (repeat.kind !== "accepted") {
      throw new TypeError(`expected an accepted submission, got ${repeat.kind}`);
    }
    expect(repeat.replayed).toBe(true);
    // The names follow the warehouses, because that is where they are read.
    expect(allocationNamesOf(repeat.order)).toStrictEqual([
      "LAX Fulfilment Center",
      "JFK Fulfilment Center",
    ]);
    // Everything that is actually stored is byte-for-byte the first body:
    // id, order number, submission key, quantity, destination, every amount,
    // and the allocations' warehouse IDs, quantities and order.
    expect(storedFactsOf(repeat.order)).toStrictEqual(firstStoredFacts);
    expect(repeat.order.id).toBe(accepted.order.id);
    expect(repeat.order.orderNumber).toBe(accepted.order.orderNumber);
    expect(repeat.order.submissionKey).toBe(accepted.order.submissionKey);
    expect(repeat.order.quantity).toBe(accepted.order.quantity);
    expect(repeat.order.destination).toStrictEqual(accepted.order.destination);
    expect({
      unitPrice: repeat.order.unitPrice.toString(),
      merchandiseSubtotal: repeat.order.merchandiseSubtotal.toString(),
      discountRate: repeat.order.discountRate,
      discountAmount: repeat.order.discountAmount.toString(),
      discountedMerchandiseTotal: repeat.order.discountedMerchandiseTotal.toString(),
      shippingCost: repeat.order.shippingCost.toString(),
      orderTotal: repeat.order.orderTotal.toString(),
    }).toStrictEqual({
      unitPrice: accepted.order.unitPrice.toString(),
      merchandiseSubtotal: accepted.order.merchandiseSubtotal.toString(),
      discountRate: accepted.order.discountRate,
      discountAmount: accepted.order.discountAmount.toString(),
      discountedMerchandiseTotal: accepted.order.discountedMerchandiseTotal.toString(),
      shippingCost: accepted.order.shippingCost.toString(),
      orderTotal: accepted.order.orderTotal.toString(),
    });

    // The direct lookups the adapter offers say the same, locked and unlocked.
    const unlocked = await store().findOrderBySubmissionKey(
      submissionKeySchema.parse(submission.submissionId),
    );
    expect(allocationNamesOf(unlocked!)).toStrictEqual([
      "LAX Fulfilment Center",
      "JFK Fulfilment Center",
    ]);
    expect(storedFactsOf(unlocked!)).toStrictEqual(firstStoredFacts);
    const locked = await store().runInTransaction(async (tx) => {
      await tx.lockInventory();
      return tx.findOrderBySubmissionKey(submissionKeySchema.parse(submission.submissionId));
    });
    expect(allocationNamesOf(locked!)).toStrictEqual([
      "LAX Fulfilment Center",
      "JFK Fulfilment Center",
    ]);
    expect(storedFactsOf(locked!)).toStrictEqual(firstStoredFacts);

    // The rename touched no stored fact of the Order.
    expect(await storedAllocations(accepted.order.id)).toStrictEqual([
      { warehouse_id: LOS_ANGELES, quantity: 355 },
      { warehouse_id: NEW_YORK, quantity: 45 },
    ]);
  });
});
