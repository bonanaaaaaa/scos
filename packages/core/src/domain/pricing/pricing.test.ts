import { describe, expect, test } from "vitest";

import { DomainDecimal } from "#domain/shared/decimal";
import { MAX_QUANTITY, type Quantity } from "#domain/shared/quantity";

import { discountRateFor, priceMerchandise } from "./pricing";

const asQuantity = (value: number): Quantity => value as Quantity;

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
      expect(discountRateFor(asQuantity(units))).toBe(rate);
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
});
