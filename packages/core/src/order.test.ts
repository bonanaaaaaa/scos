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
    expect(base.discountRate).toBe("0.05");
    expectInvalid({ ...base, quantity: 0 }, /quantity/);
    expectInvalid({ ...base, merchandiseSubtotal: Money.parse("1.00") }, /unit price/);
    expectInvalid({ ...base, discountedMerchandiseTotal: Money.parse("1.00") }, /minus discount/);
    expectInvalid({ ...base, orderTotal: Money.parse("1.00") }, /Order total/);
  });

  test("rejects a discount rate that is not the quantity's tier, even with a matching amount", () => {
    const base = validEstimate();
    // 10% of 4500.00 is 450.00, internally consistent but the wrong tier for 30 units.
    const discountAmount = Money.parse("450.00");
    expectInvalid(
      {
        ...base,
        discountRate: "0.10",
        discountAmount,
        discountedMerchandiseTotal: base.merchandiseSubtotal.minus(discountAmount),
      },
      /highest tier/,
    );
  });

  test("rejects a discount amount that does not match the rate", () => {
    const base = validEstimate();
    expectInvalid(
      {
        ...base,
        discountAmount: Money.parse("0.00"),
        discountedMerchandiseTotal: base.merchandiseSubtotal,
      },
      /subtotal times the discount rate/,
    );
  });

  test("rejects shipping that differs from the charge recomputed from the allocations", () => {
    const atWarehouse = estimateOrder({ quantity: 1 as Quantity, destination }, [
      { warehouseId: "here", latitude: 0, longitude: 0, available: 1 },
    ]);
    expect(atWarehouse.valid).toBe(true);
    expect(atWarehouse.shippingCost?.toString()).toBe("0.00");
    const shippingCost = Money.parse("5.00");
    expectInvalid(
      {
        ...atWarehouse,
        shippingCost,
        orderTotal: atWarehouse.discountedMerchandiseTotal.plus(shippingCost),
      },
      /combined charge/,
    );
  });

  test("rejects shipping above the limit even when an estimate is marked valid", () => {
    const far = estimateOrder({ quantity: 1 as Quantity, destination }, [
      { warehouseId: "far", latitude: 0, longitude: 179, available: 1 },
    ]);
    expectInvalid({ ...far, valid: true, reason: null }, /exceeds 15%/);
  });
});
