import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  errorResponseSchema,
  orderResponseSchema,
  rejectedSubmissionResponseSchema,
} from "../src/http/contracts";
import {
  AT_PARIS,
  Applications,
  FAR_AWAY,
  HONG_KONG,
  PARIS,
  postJson,
  snapshot,
} from "./support/app";
import {
  type TestDatabase,
  createTestDatabase,
  readState,
  setStock,
  stockById,
} from "./support/database";

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
  return snapshot(postJson(composed, "/orders", body));
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
      allocations: [{ warehouseId: PARIS, quantity: 400 }],
    });

    const after = await readState(db.pool);
    expect(after.orders).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({
      order_number: order.orderNumber,
      submission_key: "accept-1",
      quantity: 400,
    });
    expect(
      after.allocations.map(({ order_id, warehouse_id, quantity }) => ({
        order_id,
        warehouse_id,
        quantity,
      })),
    ).toStrictEqual([{ order_id: after.orders[0]?.id, warehouse_id: PARIS, quantity: 400 }]);

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
      shippingCost: null,
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
      { warehouseId: HONG_KONG, quantity: 1 },
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
