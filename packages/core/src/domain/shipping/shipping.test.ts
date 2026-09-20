import { describe, expect, test } from "vitest";

import { DomainDecimal } from "#domain/shared/decimal";
import { Money } from "#domain/shared/money";

import type { WarehouseAllocation } from "./allocation";
import {
  isShippingWithinLimit,
  shippingCostFor,
  shippingLimitFor,
  unroundedShippingCost,
} from "./shipping";

const allocation = ({
  warehouseId = "a",
  quantity,
  distanceKm,
}: {
  warehouseId?: string;
  quantity: number;
  distanceKm: number;
}): WarehouseAllocation => ({ warehouseId, quantity, distanceKm });

describe("shipping cost", () => {
  test("is units x 0.365 kg x $0.01/kg/km x distance", () => {
    expect(unroundedShippingCost([allocation({ quantity: 10, distanceKm: 1000 })]).toString()).toBe(
      "36.5",
    );
    expect(shippingCostFor([allocation({ quantity: 10, distanceKm: 1000 })]).toString()).toBe(
      "36.50",
    );
    expect(shippingCostFor([allocation({ quantity: 5, distanceKm: 0 })]).toString()).toBe("0.00");
    expect(shippingCostFor([]).toString()).toBe("0.00");
  });

  test("uses the distance's full string representation without rounding it", () => {
    const distanceKm = 1706.3754409277303;
    expect(unroundedShippingCost([allocation({ quantity: 1, distanceKm })]).toString()).toBe(
      new DomainDecimal("0.00365").times(new DomainDecimal("1706.3754409277303")).toString(),
    );
  });

  test("rounds the combined charge once, not each contribution (rounds up)", () => {
    // Each contribution is 0.00438, which alone rounds to 0.00.
    const plan = [
      allocation({ quantity: 1, distanceKm: 1.2 }),
      allocation({ warehouseId: "b", quantity: 1, distanceKm: 1.2 }),
    ];
    const separately = plan
      .map((entry) => shippingCostFor([entry]).toDecimal())
      .reduce((sum, value) => sum.plus(value), new DomainDecimal(0));
    expect(separately.toFixed(2)).toBe("0.00");
    expect(shippingCostFor(plan).toString()).toBe("0.01");
  });

  test("rounds the combined charge once, not each contribution (rounds down)", () => {
    // Each contribution is 0.0060225, which alone rounds to 0.01.
    const plan = [
      allocation({ quantity: 1, distanceKm: 1.65 }),
      allocation({ warehouseId: "b", quantity: 1, distanceKm: 1.65 }),
    ];
    expect(shippingCostFor([allocation({ quantity: 1, distanceKm: 1.65 })]).toString()).toBe(
      "0.01",
    );
    expect(shippingCostFor(plan).toString()).toBe("0.01");
  });

  test("keeps contributions exact beyond the decimal.js default precision of 20 digits", () => {
    // Exactly 22184.004999999999999880576; 20 significant digits would give
    // 22184.005 and round up to 22184.01.
    const plan = [allocation({ quantity: 25_833_059, distanceKm: 0.23527254705070336 })];
    expect(unroundedShippingCost(plan).toString()).toBe("22184.004999999999999880576");
    expect(shippingCostFor(plan).toString()).toBe("22184.00");
  });

  test("rounds half-up at the cent boundary", () => {
    // 0.00365 x 1 x 1.37 = 0.0050005 -> 0.01; 1 x 1.36 = 0.004964 -> 0.00
    expect(shippingCostFor([allocation({ quantity: 1, distanceKm: 1.37 })]).toString()).toBe(
      "0.01",
    );
    expect(shippingCostFor([allocation({ quantity: 1, distanceKm: 1.36 })]).toString()).toBe(
      "0.00",
    );
    // An exact half cent rounds up.
    expect(Money.roundToCents(new DomainDecimal("22.505")).toString()).toBe("22.51");
  });
});

describe("shipping limit", () => {
  const discounted = Money.parse("100.00");

  test("is exactly 15% of discounted merchandise", () => {
    expect(shippingLimitFor(discounted).toString()).toBe("15");
    expect(shippingLimitFor(Money.parse("3562.50")).toString()).toBe("534.375");
  });

  test("passes below and at the limit, fails above", () => {
    expect(isShippingWithinLimit(Money.parse("14.99"), discounted)).toBe(true);
    expect(isShippingWithinLimit(Money.parse("15.00"), discounted)).toBe(true);
    expect(isShippingWithinLimit(Money.parse("15.01"), discounted)).toBe(false);
  });

  test("compares the rounded charge against the exact limit", () => {
    // Unrounded 15.004 exceeds 15 but rounds to 15.00, which passes.
    expect(isShippingWithinLimit(Money.roundToCents(new DomainDecimal("15.004")), discounted)).toBe(
      true,
    );
    expect(isShippingWithinLimit(Money.roundToCents(new DomainDecimal("15.005")), discounted)).toBe(
      false,
    );
    // The limit may have sub-cent digits: 534.375 allows 534.37 but not 534.38.
    const net = Money.parse("3562.50");
    expect(isShippingWithinLimit(Money.parse("534.37"), net)).toBe(true);
    expect(isShippingWithinLimit(Money.parse("534.38"), net)).toBe(false);
  });
});
