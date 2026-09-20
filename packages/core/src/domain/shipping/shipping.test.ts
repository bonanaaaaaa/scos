import { describe, expect, test } from "vitest";

import { DomainDecimal } from "#domain/shared/decimal";
import { Money } from "#domain/shared/money";

import type { WarehouseAllocation } from "./allocation";
import {
  isShippingWithinLimit,
  publishedShippingLimitFor,
  shippingCostFor,
  shippingLimitFor,
  unroundedShippingCost,
} from "./shipping";

const allocation = ({
  warehouseId = "a",
  warehouseName = `Warehouse ${warehouseId}`,
  quantity,
  distanceKm,
}: {
  warehouseId?: string;
  warehouseName?: string;
  quantity: number;
  distanceKm: number;
}): WarehouseAllocation => ({ warehouseId, warehouseName, quantity, distanceKm });

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

describe("published shipping limit", () => {
  /** Discounted totals whose exact 15% limit has digits below the cent. */
  const SUB_CENT_LIMITS = ["150.05", "1500.01", "3562.50", "233.33"];

  test("truncates the exact limit toward zero to cents", () => {
    // 15% of 1500.01 is exactly 225.0015: four decimals, all discarded.
    expect(publishedShippingLimitFor(Money.parse("1500.01")).toString()).toBe("225.00");
    expect(publishedShippingLimitFor(Money.parse("3562.50")).toString()).toBe("534.37");
    // A limit already at cent scale is published unchanged.
    expect(publishedShippingLimitFor(Money.parse("100.00")).toString()).toBe("15.00");
    expect(publishedShippingLimitFor(Money.parse("0.00")).toString()).toBe("0.00");
  });

  test("truncates rather than rounding half-up", () => {
    // Half-up would publish 22.51 and so admit a cost the server rejects.
    const discounted = Money.parse("150.05");
    expect(shippingLimitFor(discounted).toString()).toBe("22.5075");
    expect(publishedShippingLimitFor(discounted).toString()).toBe("22.50");
    expect(isShippingWithinLimit(Money.parse("22.51"), discounted)).toBe(false);
  });

  test("decides the same as the exact limit at the boundary cent and either side", () => {
    for (const total of SUB_CENT_LIMITS) {
      const discounted = Money.parse(total);
      const published = publishedShippingLimitFor(discounted);
      // Truncation really moved the limit here, so the two could disagree.
      expect(shippingLimitFor(discounted).equals(published.toDecimal())).toBe(false);
      for (const offset of ["-0.01", "0.00", "0.01"]) {
        const cost = Money.fromDecimal(published.toDecimal().plus(new DomainDecimal(offset)));
        expect(isShippingWithinLimit(cost, discounted)).toBe(
          cost.toDecimal().lessThanOrEqualTo(published.toDecimal()),
        );
      }
    }
  });

  test("decides the same as the exact limit across a range of discounted totals", () => {
    for (let cents = 100; cents <= 500_000; cents += 997) {
      const discounted = Money.fromDecimal(new DomainDecimal(cents).dividedBy(100));
      const published = publishedShippingLimitFor(discounted);
      for (const offset of ["-0.01", "0.00", "0.01"]) {
        const cost = Money.fromDecimal(published.toDecimal().plus(new DomainDecimal(offset)));
        expect(isShippingWithinLimit(cost, discounted)).toBe(
          cost.toDecimal().lessThanOrEqualTo(published.toDecimal()),
        );
      }
    }
  });

  test("is never above the exact limit", () => {
    for (let cents = 0; cents <= 500_000; cents += 997) {
      const discounted = Money.fromDecimal(new DomainDecimal(cents).dividedBy(100));
      expect(
        publishedShippingLimitFor(discounted)
          .toDecimal()
          .lessThanOrEqualTo(shippingLimitFor(discounted)),
      ).toBe(true);
    }
  });
});
