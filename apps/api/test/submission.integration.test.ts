import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  errorResponseSchema,
  orderResponseSchema,
  rejectedSubmissionResponseSchema,
  shippingExceedsLimitEstimateSchema,
  verifyOrderResponseSchema,
} from "#index";
import {
  AT_PARIS,
  Applications,
  FAR_AWAY,
  HONG_KONG,
  PARIS,
  WARSAW,
  cents,
  postJson,
  shippingLimitCents,
  snapshot,
} from "#test/support/app";
import {
  type TestDatabase,
  createTestDatabase,
  readState,
  setStock,
  stockById,
} from "#test/support/database";

let db: TestDatabase;
const applications = new Applications();

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.reset();
});

afterEach(async () => {
  await applications.closeAll();
});

function submit(body: unknown, composed = applications.compose(db.url)) {
  return snapshot(postJson(composed, "/api/v1/orders", body));
}

describe("acceptance", () => {
  test("stores one Order with its allocations and deducts exactly the allocated stock", async () => {
    const stockBefore = await stockById(db.pool);
    const before = await readState(db.pool);

    // 400 units at Paris: Paris has 694, so a single allocation; 20% discount.
    const response = await submit({ submissionId: "accept-1", quantity: 400, ...AT_PARIS });

    expect(response.status, response.text).toBe(201);
    const order = orderResponseSchema.strict().parse(response.json());
    expect(order).toMatchObject({
      submissionId: "accept-1",
      quantity: 400,
      destination: AT_PARIS,
      unitPrice: "150.00",
      merchandiseSubtotal: "60000.00",
      discountRate: "0.20",
      discountAmount: "12000.00",
      discountedMerchandiseTotal: "48000.00",
      shippingCost: "0.00",
      orderTotal: "48000.00",
      allocations: [{ warehouseId: PARIS, warehouseName: "Paris", quantity: 400 }],
    });

    const after = await readState(db.pool);
    expect(after.orders).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({
      order_number: order.orderNumber,
      submission_key: "accept-1",
      quantity: 400,
    });
    // An allocation row stores the warehouse's ID and quantity and no name:
    // the name the 201 reported was resolved through this foreign key.
    expect(
      after.allocations.map(({ order_id, warehouse_id, quantity }) => ({
        order_id,
        warehouse_id,
        quantity,
      })),
    ).toStrictEqual([{ order_id: after.orders[0]?.id, warehouse_id: PARIS, quantity: 400 }]);
    const nameById = new Map(after.warehouses.map(({ id, name }) => [id, name]));
    expect(
      order.allocations.map(({ warehouseId, warehouseName }) => [warehouseId, warehouseName]),
    ).toStrictEqual(
      after.allocations.map(({ warehouse_id }) => [warehouse_id, nameById.get(warehouse_id)]),
    );

    const stockAfter = await stockById(db.pool);
    expect(stockAfter).toStrictEqual({ ...stockBefore, [PARIS]: (stockBefore[PARIS] ?? 0) - 400 });
    // Warehouses without an allocation were not rewritten.
    expect(after.warehouses.filter((row) => row.id !== PARIS)).toStrictEqual(
      before.warehouses.filter((row) => row.id !== PARIS),
    );
  });

  test("a split allocation deducts from each warehouse it names", async () => {
    await setStock(db.pool, { [PARIS]: 5 });
    const stockBefore = await stockById(db.pool);

    const response = await submit({ submissionId: "split-1", quantity: 12, ...AT_PARIS });

    expect(response.status, response.text).toBe(201);
    const order = orderResponseSchema.parse(response.json());
    expect(order.allocations.reduce((sum, { quantity }) => sum + quantity, 0)).toBe(12);
    const expected = { ...stockBefore };
    for (const { warehouseId, quantity } of order.allocations) {
      expected[warehouseId] = (expected[warehouseId] ?? 0) - quantity;
    }
    expect(await stockById(db.pool)).toStrictEqual(expected);
  });

  test("a split Order names every warehouse it draws from, each name read from warehouses", async () => {
    // Only 5 units left at Paris, so the plan reaches past it to Warsaw.
    await setStock(db.pool, { [PARIS]: 5 });

    const response = await submit({ submissionId: "split-names-1", quantity: 12, ...AT_PARIS });

    expect(response.status, response.text).toBe(201);
    const order = orderResponseSchema.strict().parse(response.json());
    // Nearest first, ties by warehouseId: the name rides along, it never
    // reorders the plan.
    expect(
      order.allocations.map(({ warehouseId, warehouseName, quantity }) => [
        warehouseId,
        warehouseName,
        quantity,
      ]),
    ).toStrictEqual([
      [PARIS, "Paris", 5],
      [WARSAW, "Warsaw", 7],
    ]);

    // The rows store two warehouse IDs and no names; each reported name is the
    // `warehouses` row for its own allocation's warehouse_id, not the first.
    const { allocations, warehouses } = await readState(db.pool);
    const nameById = new Map(warehouses.map(({ id, name }) => [id, name]));
    expect(allocations.map(({ warehouse_id }) => warehouse_id).sort()).toStrictEqual(
      [PARIS, WARSAW].sort(),
    );
    expect(
      Object.fromEntries(
        order.allocations.map(({ warehouseId, warehouseName }) => [warehouseId, warehouseName]),
      ),
    ).toStrictEqual({ [PARIS]: nameById.get(PARIS), [WARSAW]: nameById.get(WARSAW) });
  });

  test("the stored monetary facts of a split Order with shipping equal the 201 response", async () => {
    await setStock(db.pool, { [PARIS]: 5 });

    // 30 units at Paris: 5 from Paris and 25 shipped from elsewhere, so shipping is nonzero;
    // 30 units also earn the 5% Volume Discount.
    const response = await submit({ submissionId: "split-money-1", quantity: 30, ...AT_PARIS });

    expect(response.status, response.text).toBe(201);
    const order = orderResponseSchema.strict().parse(response.json());
    expect(order.allocations.length).toBeGreaterThan(1);
    expect(order.shippingCost).not.toBe("0.00");

    // Stored facts, and the totals derived from them with exact NUMERIC arithmetic in PostgreSQL.
    const stored = await db.pool.query<{
      quantity: number;
      unit_price: string;
      discount_rate: string;
      discount_amount: string;
      shipping_cost: string;
      merchandise_subtotal: string;
      discounted_merchandise_total: string;
      order_total: string;
    }>(
      `SELECT quantity,
              unit_price::text AS unit_price,
              discount_rate::text AS discount_rate,
              discount_amount::text AS discount_amount,
              shipping_cost::text AS shipping_cost,
              (unit_price * quantity)::text AS merchandise_subtotal,
              (unit_price * quantity - discount_amount)::text AS discounted_merchandise_total,
              (unit_price * quantity - discount_amount + shipping_cost)::text AS order_total
       FROM orders WHERE order_number = $1`,
      [order.orderNumber],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toStrictEqual({
      quantity: order.quantity,
      unit_price: order.unitPrice,
      discount_rate: order.discountRate,
      discount_amount: order.discountAmount,
      shipping_cost: order.shippingCost,
      merchandise_subtotal: order.merchandiseSubtotal,
      discounted_merchandise_total: order.discountedMerchandiseTotal,
      order_total: order.orderTotal,
    });
    expect(order).toMatchObject({
      quantity: 30,
      unitPrice: "150.00",
      merchandiseSubtotal: "4500.00",
      discountRate: "0.05",
      discountAmount: "225.00",
      discountedMerchandiseTotal: "4275.00",
      shippingCost: "122.53",
      orderTotal: "4397.53",
    });
  });
});

describe("business rejections write nothing and leave the submissionId reusable", () => {
  test("INSUFFICIENT_STOCK, then the same submissionId succeeds after restocking", async () => {
    const before = await readState(db.pool);
    const body = { submissionId: "reject-stock", quantity: 3_000, ...AT_PARIS };

    const rejected = await submit(body);

    expect(rejected.status, rejected.text).toBe(422);
    const rejection = rejectedSubmissionResponseSchema.parse(rejected.json());
    expect(rejection.error.code).toBe("INSUFFICIENT_STOCK");
    expect(rejection.estimate).toMatchObject({
      unitPrice: "150.00",
      shippingCost: null,
      // Nothing can be shipped, so there is no limit to compare against.
      shippingLimit: null,
      orderTotal: null,
      allocations: [],
    });
    expect(await readState(db.pool)).toStrictEqual(before);

    await setStock(db.pool, { [PARIS]: 3_000 });
    const accepted = await submit(body);
    expect(accepted.status, accepted.text).toBe(201);
    expect((await stockById(db.pool))[PARIS]).toBe(0);
  });

  test("SHIPPING_EXCEEDS_LIMIT, then the same submissionId succeeds once stock is nearby", async () => {
    const before = await readState(db.pool);
    const body = { submissionId: "reject-shipping", quantity: 1, ...FAR_AWAY };

    const rejected = await submit(body);

    expect(rejected.status, rejected.text).toBe(422);
    const rejection = rejectedSubmissionResponseSchema.parse(rejected.json());
    expect(rejection.error.code).toBe("SHIPPING_EXCEEDS_LIMIT");
    const estimate = shippingExceedsLimitEstimateSchema.parse(rejection.estimate);
    expect(estimate.unitPrice).toBe("150.00");
    // The limit the estimate was tested against: 15% of 150.00, truncated.
    // Compared as integer cents, so no amount is ever a binary float.
    expect(estimate.shippingLimit).toBe("22.50");
    expect(cents(estimate.shippingLimit)).toBe(
      shippingLimitCents(estimate.discountedMerchandiseTotal),
    );
    expect(Number(rejection.estimate.shippingCost)).toBeGreaterThan(22.5);
    expect(await readState(db.pool)).toStrictEqual(before);

    // Circumstances change: a warehouse now stands at the destination.
    await db.pool.query("UPDATE warehouses SET latitude = $2, longitude = $3 WHERE id = $1::uuid", [
      HONG_KONG,
      FAR_AWAY.latitude,
      FAR_AWAY.longitude,
    ]);
    const accepted = await submit(body);
    expect(accepted.status, accepted.text).toBe(201);
    expect(orderResponseSchema.parse(accepted.json()).allocations).toStrictEqual([
      { warehouseId: HONG_KONG, warehouseName: "Hong Kong", quantity: 1 },
    ]);
  });

  test("a malformed request consumes no submissionId and changes nothing", async () => {
    const before = await readState(db.pool);

    const invalid = await submit({ submissionId: "invalid-1", quantity: "5", ...AT_PARIS });

    expect(invalid.status).toBe(400);
    expect(errorResponseSchema.parse(invalid.json()).error.code).toBe("INVALID_REQUEST");
    expect(await readState(db.pool)).toStrictEqual(before);
    expect((await submit({ submissionId: "invalid-1", quantity: 5, ...AT_PARIS })).status).toBe(
      201,
    );
  });
});

describe("repeats and conflicts", () => {
  test("a repeat returns the original Order after stock changes, without deduction or rewrites", async () => {
    const body = { submissionId: "repeat-1", quantity: 50, ...AT_PARIS };
    const first = await submit(body);
    expect(first.status, first.text).toBe(201);

    // New evaluation would now fail, but a repeat is not re-evaluated.
    await setStock(db.pool, { [PARIS]: 0 });
    const before = await readState(db.pool);

    const repeat = await submit(body);

    expect(repeat.status).toBe(201);
    expect(repeat.text).toBe(first.text);
    expect(await readState(db.pool)).toStrictEqual(before);
  });

  test("a repeat after a rename reports the new warehouse name and every other field unchanged", async () => {
    // Why the name moves and nothing else does: an allocation's warehouseName
    // is resolved through order_allocations.warehouse_id, so it tracks the
    // warehouse and a rename shows up in later reads of an Order already
    // returned. The amounts, quantities and the plan itself are the genuine
    // historical facts of the Order, so they are stored and a rename cannot
    // touch them.
    const composed = applications.compose(db.url);
    const body = { submissionId: "rename-1", quantity: 10, ...AT_PARIS };
    const first = await submit(body, composed);
    expect(first.status, first.text).toBe(201);
    const original = orderResponseSchema.strict().parse(first.json());
    expect(original.allocations).toStrictEqual([
      { warehouseId: PARIS, warehouseName: "Paris", quantity: 10 },
    ]);

    await db.pool.query("UPDATE warehouses SET name = $2 WHERE id = $1::uuid", [
      PARIS,
      "Paris Nord",
    ]);
    const before = await readState(db.pool);
    const stockBefore = await stockById(db.pool);

    const repeat = await submit(body, composed);

    expect(repeat.status, repeat.text).toBe(201);
    const repeated = orderResponseSchema.strict().parse(repeat.json());
    // The one field that may differ: this allocation's warehouseName.
    expect(repeated.allocations).toStrictEqual([
      { warehouseId: PARIS, warehouseName: "Paris Nord", quantity: 10 },
    ]);
    // Everything else is exactly what it was — order number, submissionId,
    // quantity, destination, every amount, and the allocation warehouse IDs
    // and quantities in their original order.
    const withoutNames = (order: typeof original) => ({
      ...order,
      allocations: order.allocations.map(({ warehouseId, quantity }) => ({
        warehouseId,
        quantity,
      })),
    });
    expect(withoutNames(repeated)).toStrictEqual(withoutNames(original));
    // No second deduction, and no row was rewritten: `before` was read after
    // the rename, so the only change it already accounts for is the rename.
    expect(await stockById(db.pool)).toStrictEqual(stockBefore);
    expect(await readState(db.pool)).toStrictEqual(before);

    // A fresh estimate plans against the warehouses as they stand, so it names
    // the renamed warehouse too — the two sides agree.
    const estimate = await snapshot(
      postJson(composed, "/api/v1/orders/verify", { quantity: 10, ...AT_PARIS }),
    );
    expect(estimate.status, estimate.text).toBe(200);
    expect(verifyOrderResponseSchema.parse(estimate.json()).allocations).toStrictEqual([
      { warehouseId: PARIS, warehouseName: "Paris Nord", quantity: 10, distanceKm: 0 },
    ]);
  });

  test("a repeat after a restart (new composition, new pool) returns the same Order", async () => {
    const body = { submissionId: "restart-1", quantity: 30, ...AT_PARIS };
    const beforeRestart = applications.compose(db.url);
    const first = await submit(body, beforeRestart);
    expect(first.status, first.text).toBe(201);
    await beforeRestart.close();
    const before = await readState(db.pool);

    const afterRestart = applications.compose(db.url);
    const repeat = await submit(body, afterRestart);

    expect(repeat.status).toBe(201);
    expect(repeat.text).toBe(first.text);
    expect(await readState(db.pool)).toStrictEqual(before);
  });

  test("changed input conflicts with 409 and leaves the Order unchanged", async () => {
    const first = await submit({ submissionId: "conflict-1", quantity: 30, ...AT_PARIS });
    expect(first.status, first.text).toBe(201);
    const order = orderResponseSchema.parse(first.json());
    const before = await readState(db.pool);

    for (const changed of [
      { submissionId: "conflict-1", quantity: 31, ...AT_PARIS },
      { submissionId: "conflict-1", quantity: 30, ...AT_PARIS, longitude: 2.5 },
    ]) {
      const conflict = await submit(changed);
      expect(conflict.status, conflict.text).toBe(409);
      expect(errorResponseSchema.strict().parse(conflict.json()).error.code).toBe(
        "SUBMISSION_ID_CONFLICT",
      );
      expect(conflict.text).not.toContain(order.orderNumber);
      expect(await readState(db.pool)).toStrictEqual(before);
    }

    const repeat = await submit({ submissionId: "conflict-1", quantity: 30, ...AT_PARIS });
    expect(repeat.text).toBe(first.text);
  });
});
