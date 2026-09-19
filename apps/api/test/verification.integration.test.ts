import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { verifyOrderResponseSchema } from "../src/index";
import { AT_PARIS, Applications, FAR_AWAY, PARIS, WARSAW, postJson, snapshot } from "./support/app";
import {
  type TestDatabase,
  createTestDatabase,
  readState,
  setAllStock,
  setStock,
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

async function verify(body: unknown) {
  const composed = applications.compose(db.url);
  const response = await snapshot(postJson(composed, "/api/v1/orders/verify", body));
  expect(response.status, response.text).toBe(200);
  return verifyOrderResponseSchema.parse(response.json());
}

describe("POST /api/v1/orders/verify against PostgreSQL", () => {
  test.each([
    ["a valid estimate", { quantity: 10, ...AT_PARIS }, true, null],
    ["excessive shipping", { quantity: 1, ...FAR_AWAY }, false, "SHIPPING_EXCEEDS_LIMIT"],
    ["insufficient stock", { quantity: 3_000, ...AT_PARIS }, false, "INSUFFICIENT_STOCK"],
  ] as const)(
    "%s leaves every warehouse row and the Order tables unchanged",
    async (_name, body, valid, reason) => {
      const before = await readState(db.pool);
      expect(before.orders).toHaveLength(0);

      const estimate = await verify(body);

      expect(estimate.valid).toBe(valid);
      expect(estimate.reason).toBe(reason);
      if (reason === "INSUFFICIENT_STOCK") {
        expect(estimate.shippingCost).toBeNull();
        expect(estimate.orderTotal).toBeNull();
        expect(estimate.allocations).toStrictEqual([]);
        expect(estimate.merchandiseSubtotal).toBe("450000.00");
      } else {
        expect(estimate.shippingCost).toMatch(/^\d+\.\d{2}$/);
        expect(estimate.allocations.length).toBeGreaterThan(0);
      }
      // Stock, created_at/updated_at, xmin/ctid and Order rows all identical.
      expect(await readState(db.pool)).toStrictEqual(before);
    },
  );

  test("a valid estimate allocates the nearest stock with decimal-string money", async () => {
    const estimate = await verify({ quantity: 10, ...AT_PARIS });

    expect(estimate).toMatchObject({
      valid: true,
      reason: null,
      quantity: 10,
      destination: AT_PARIS,
      merchandiseSubtotal: "1500.00",
      discountRate: "0.00",
      discountAmount: "0.00",
      discountedMerchandiseTotal: "1500.00",
      shippingCost: "0.00",
      orderTotal: "1500.00",
      allocations: [{ warehouseId: PARIS, quantity: 10, distanceKm: 0 }],
    });
  });

  test("a repeat after a stock change reflects the new stock", async () => {
    const first = await verify({ quantity: 10, ...AT_PARIS });
    expect(first.allocations).toStrictEqual([{ warehouseId: PARIS, quantity: 10, distanceKm: 0 }]);

    await setStock(db.pool, { [PARIS]: 4 });
    const second = await verify({ quantity: 10, ...AT_PARIS });
    expect(second.valid).toBe(true);
    expect(
      second.allocations.map(({ warehouseId, quantity }) => [warehouseId, quantity]),
    ).toStrictEqual([
      [PARIS, 4],
      [WARSAW, 6],
    ]);
    expect(Number(second.shippingCost)).toBeGreaterThan(0);

    await setAllStock(db.pool, {}, 0);
    const third = await verify({ quantity: 10, ...AT_PARIS });
    expect(third).toMatchObject({ valid: false, reason: "INSUFFICIENT_STOCK", shippingCost: null });
  });
});
