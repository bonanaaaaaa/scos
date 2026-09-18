import { describe, expect, test } from "vitest";

import type { WarehouseAllocation } from "./allocation";
import { DomainDecimal } from "./decimal";
import { Money } from "./money";
import {
  discountRateFor,
  isShippingWithinLimit,
  priceMerchandise,
  shippingCostFor,
  shippingLimitFor,
  unroundedShippingCost,
} from "./pricing";
import { MAX_QUANTITY, type Quantity } from "./quantity";

const asQuantity = (value: number): Quantity => value as Quantity;
const allocation = ({
  warehouseId = "a",
  quantity,
  distanceKm,
}: {
  warehouseId?: string;
  quantity: number;
  distanceKm: number;
}): WarehouseAllocation => ({ warehouseId, quantity, distanceKm });

describe("volume discount", () => {
  test.each([
    [1, "0.00", "150.00", "0.00", "150.00"],
    [24, "0.00", "3600.00", "0.00", "3600.00"],
    [25, "0.05", "3750.00", "187.50", "3562.50"],
    [49, "0.05", "7350.00", "367.50", "6982.50"],
    [50, "0.10", "7500.00", "750.00", "6750.00"],
    [99, "0.10", "14850.00", "1485.00", "13365.00"],
    [100, "0.15", "15000.00", "2250.00", "12750.00"],
    [249, "0.15", "37350.00", "5602.50", "31747.50"],
    [250, "0.20", "37500.00", "7500.00", "30000.00"],
    [251, "0.20", "37650.00", "7530.00", "30120.00"],
  ])(
    "%s units: rate %s, subtotal %s, discount %s, discounted %s",
    (units, rate, sub, disc, net) => {
      expect(discountRateFor(units)).toBe(rate);
      const pricing = priceMerchandise(asQuantity(units));
      expect(pricing.discountRate).toBe(rate);
      expect(pricing.merchandiseSubtotal.toString()).toBe(sub);
      expect(pricing.discountAmount.toString()).toBe(disc);
      expect(pricing.discountedMerchandiseTotal.toString()).toBe(net);
    },
  );

  test("discount and discounted totals are exact at cents for every quantity (no rounding)", () => {
    for (let units = 1; units <= 1000; units += 1) {
      const pricing = priceMerchandise(asQuantity(units));
      const exactDiscount = pricing.merchandiseSubtotal
        .toDecimal()
        .times(new DomainDecimal(pricing.discountRate));
      expect(pricing.discountAmount.toDecimal().equals(exactDiscount)).toBe(true);
    }
  });

  test("the largest supported quantity is representable", () => {
    const pricing = priceMerchandise(asQuantity(MAX_QUANTITY));
    expect(pricing.merchandiseSubtotal.toString()).toBe("9999999900.00");
    expect(pricing.discountedMerchandiseTotal.toString()).toBe("7999999920.00");
  });

  test("falls back to no discount below every tier", () => {
    expect(discountRateFor(-1)).toBe("0.00");
  });
});

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
