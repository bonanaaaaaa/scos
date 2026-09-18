import { describe, expect, test } from "vitest";

import type { WarehouseStock } from "./allocation.js";
import type { Destination } from "./destination.js";
import { DomainError } from "./errors.js";
import { type OrderEstimate, type ValidOrderEstimate, estimateOrder } from "./estimate.js";
import { Money } from "./money.js";
import { createOrder } from "./order.js";
import type { Quantity } from "./quantity.js";

const destination = { latitude: 0, longitude: 0 } as Destination;
const inventory: readonly WarehouseStock[] = [
  { warehouseId: "a", latitude: 0, longitude: 1, available: 20 },
  { warehouseId: "b", latitude: 0, longitude: 2, available: 20 },
];

function validEstimate(): ValidOrderEstimate {
  const estimate = estimateOrder({ quantity: 30 as Quantity, destination }, inventory);
  if (!estimate.valid) throw new Error("fixture must be valid");
  return estimate;
}

const expectInvalid = (estimate: unknown, message: RegExp, id = "id-1", orderNumber = "SO-1") => {
  const run = () => createOrder({ id, orderNumber, estimate: estimate as OrderEstimate });
  expect(run).toThrow(DomainError);
  expect(run).toThrow(message);
};

describe("createOrder", () => {
  test("creates an immutable order from a valid estimate", () => {
    const estimate = validEstimate();
    const order = createOrder({ id: "id-1", orderNumber: "SO-1", estimate });
    expect(order).toMatchObject({ id: "id-1", orderNumber: "SO-1", quantity: 30 });
    expect(order.orderTotal.toString()).toBe(estimate.orderTotal.toString());
    expect(order.allocations.map((entry) => [entry.warehouseId, entry.quantity])).toEqual([
      ["a", 20],
      ["b", 10],
    ]);
    expect(Object.isFrozen(order)).toBe(true);
    expect(Object.isFrozen(order.allocations)).toBe(true);
    expect(Object.isFrozen(order.allocations[0])).toBe(true);
  });

  test("rejects insufficient-stock and shipping-limit estimates", () => {
    expectInvalid(
      estimateOrder({ quantity: 41 as Quantity, destination }, inventory),
      /INSUFFICIENT_STOCK/,
    );
    const far = estimateOrder({ quantity: 1 as Quantity, destination }, [
      { warehouseId: "far", latitude: 0, longitude: 179, available: 1 },
    ]);
    expect(far.reason).toBe("SHIPPING_EXCEEDS_LIMIT");
    expectInvalid(far, /SHIPPING_EXCEEDS_LIMIT/);
  });

  test("requires identifiers", () => {
    expectInvalid(validEstimate(), /id is required/, "");
    expectInvalid(validEstimate(), /number is required/, "id", "");
  });

  test("enforces allocation invariants", () => {
    const base = validEstimate();
    const [first, second] = base.allocations;
    expectInvalid({ ...base, allocations: [] }, /at least one/);
    expectInvalid(
      { ...base, allocations: [{ ...first, quantity: 0 }, second] },
      /positive integer/,
    );
    expectInvalid(
      {
        ...base,
        allocations: [
          { ...first, quantity: 19.5 },
          { ...second, quantity: 10.5 },
        ],
      },
      /positive integer/,
    );
    expectInvalid({ ...base, allocations: [{ ...first, distanceKm: -1 }, second] }, /distance/);
    expectInvalid(
      { ...base, allocations: [first, { ...second, warehouseId: "a" }] },
      /more than once/,
    );
    expectInvalid({ ...base, allocations: [first] }, /sum to the ordered quantity/);
  });

  test("enforces amount invariants", () => {
    const base = validEstimate();
    expectInvalid({ ...base, quantity: 0 }, /quantity/);
    expectInvalid({ ...base, merchandiseSubtotal: Money.parse("1.00") }, /unit price/);
    expectInvalid({ ...base, discountAmount: Money.parse("0.00") }, /subtotal minus discount/);
    expectInvalid(
      {
        ...base,
        shippingCost: Money.parse("1000.00"),
        orderTotal: base.discountedMerchandiseTotal.plus(Money.parse("1000.00")),
      },
      /exceeds 15%/,
    );
    expectInvalid({ ...base, orderTotal: Money.parse("1.00") }, /Order total/);
  });
});
