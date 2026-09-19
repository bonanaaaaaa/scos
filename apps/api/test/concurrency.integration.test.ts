import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { orderResponseSchema, rejectedSubmissionResponseSchema } from "../src/http/contracts";
import { AT_PARIS, Applications, PARIS, postJson, snapshot } from "./support/app";
import {
  type TestDatabase,
  createTestDatabase,
  holdWarehouseLocks,
  readState,
  setAllStock,
  stockById,
  waitForLockWaiters,
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

/**
 * Controlled overlap: a separate connection holds every warehouse row lock,
 * all requests are fired and observed waiting on that lock (each on its own
 * pooled connection), then the lock is released and they race.
 */
async function overlapping(bodies: readonly unknown[]) {
  const composed = applications.compose(db.url);
  const locks = await holdWarehouseLocks(db.url);
  try {
    const pending = bodies.map((body) => snapshot(postJson(composed, "/orders", body)));
    await waitForLockWaiters(db.pool, bodies.length);
    await locks.release();
    return await Promise.all(pending);
  } finally {
    await locks.release();
  }
}

const N = 6;

describe("concurrent submissions on distinct connections", () => {
  test("identical submissions create one Order and deduct stock once", async () => {
    const stockBefore = await stockById(db.pool);
    const body = { submissionId: "same-1", quantity: 20, ...AT_PARIS };

    const responses = await overlapping(Array.from({ length: N }, () => body));

    expect(responses.map((response) => response.status)).toStrictEqual(Array(N).fill(201));
    // Every response is the same Order, byte for byte.
    expect(new Set(responses.map((response) => response.text)).size).toBe(1);
    const order = orderResponseSchema.parse(responses[0]?.json());

    const state = await readState(db.pool);
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]?.order_number).toBe(order.orderNumber);
    expect(state.allocations).toHaveLength(1);
    expect(await stockById(db.pool)).toStrictEqual({
      ...stockBefore,
      [PARIS]: (stockBefore[PARIS] ?? 0) - 20,
    });
  });

  test("competing submissions for scarce stock never oversell", async () => {
    await setAllStock(db.pool, { [PARIS]: 10 });

    const responses = await overlapping(
      Array.from({ length: N }, (_, index) => ({
        submissionId: `scarce-${index}`,
        quantity: 4,
        ...AT_PARIS,
      })),
    );

    const accepted = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status === 422);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(N - 2);
    for (const response of rejected) {
      expect(rejectedSubmissionResponseSchema.parse(response.json()).error.code).toBe(
        "INSUFFICIENT_STOCK",
      );
    }

    const state = await readState(db.pool);
    const acceptedUnits = state.orders.reduce((sum, order) => sum + order.quantity, 0);
    expect(state.orders).toHaveLength(accepted.length);
    expect(acceptedUnits).toBe(8);
    expect(acceptedUnits).toBeLessThanOrEqual(10);
    const stock = await stockById(db.pool);
    expect(stock[PARIS]).toBe(10 - acceptedUnits);
    expect(Object.values(stock).every((value) => value >= 0)).toBe(true);
  });

  test("concurrent reuse of one submissionId with changed input accepts one and conflicts the rest", async () => {
    const stockBefore = await stockById(db.pool);

    const responses = await overlapping(
      Array.from({ length: N }, (_, index) => ({
        submissionId: "reused-1",
        quantity: index + 1,
        ...AT_PARIS,
      })),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toStrictEqual([201, ...Array(N - 1).fill(409)]);
    const winner = orderResponseSchema.parse(
      responses.find((response) => response.status === 201)?.json(),
    );

    const state = await readState(db.pool);
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]?.quantity).toBe(winner.quantity);
    expect(await stockById(db.pool)).toStrictEqual({
      ...stockBefore,
      [PARIS]: (stockBefore[PARIS] ?? 0) - winner.quantity,
    });
  });
});
