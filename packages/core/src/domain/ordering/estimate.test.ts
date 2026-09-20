import { describe, expect, test } from "vitest";

import type { Destination } from "#domain/shared/destination";
import { DomainError } from "#domain/shared/errors";
import type { Quantity } from "#domain/shared/quantity";
import type { WarehouseStock } from "#domain/shipping/allocation";
import { EARTH_RADIUS_KM } from "#domain/shipping/distance";
import { publishedShippingLimitFor } from "#domain/shipping/shipping";

import { type OrderEstimate, estimateOrder } from "./estimate";

const asQuantity = (value: number): Quantity => value as Quantity;
const destinationAt = (latitude: number, longitude: number): Destination =>
  ({ latitude, longitude }) as Destination;

/** Equator longitude whose distance from (0, 0) is `km`. */
const longitudeForKm = (km: number): number => ((km / EARTH_RADIUS_KM) * 180) / Math.PI;

const PRD_WAREHOUSES: readonly WarehouseStock[] = [
  {
    warehouseId: "wh-1-los-angeles",
    warehouseName: "Los Angeles",
    latitude: 33.9425,
    longitude: -118.408056,
    available: 355,
  },
  {
    warehouseId: "wh-2-new-york",
    warehouseName: "New York",
    latitude: 40.639722,
    longitude: -73.778889,
    available: 578,
  },
  {
    warehouseId: "wh-3-sao-paulo",
    warehouseName: "São Paulo",
    latitude: -23.435556,
    longitude: -46.473056,
    available: 265,
  },
  {
    warehouseId: "wh-4-paris",
    warehouseName: "Paris",
    latitude: 49.009722,
    longitude: 2.547778,
    available: 694,
  },
  {
    warehouseId: "wh-5-warsaw",
    warehouseName: "Warsaw",
    latitude: 52.165833,
    longitude: 20.967222,
    available: 245,
  },
  {
    warehouseId: "wh-6-hong-kong",
    warehouseName: "Hong Kong",
    latitude: 22.308889,
    longitude: 113.914444,
    available: 419,
  },
];

const summarise = (estimate: OrderEstimate) => ({
  valid: estimate.valid,
  reason: estimate.reason,
  merchandiseSubtotal: estimate.merchandiseSubtotal.toString(),
  discountRate: estimate.discountRate,
  discountAmount: estimate.discountAmount.toString(),
  discountedMerchandiseTotal: estimate.discountedMerchandiseTotal.toString(),
  shippingCost: estimate.shippingCost?.toString() ?? null,
  orderTotal: estimate.orderTotal?.toString() ?? null,
  allocations: estimate.allocations.map(({ warehouseId, quantity }) => [warehouseId, quantity]),
});

describe("estimateOrder", () => {
  test("a destination at a warehouse ships for free", () => {
    const estimate = estimateOrder({ quantity: asQuantity(3), destination: destinationAt(0, 0) }, [
      { warehouseId: "w", warehouseName: "Paris", latitude: 0, longitude: 0, available: 3 },
    ]);
    expect(summarise(estimate)).toEqual({
      valid: true,
      reason: null,
      merchandiseSubtotal: "450.00",
      discountRate: "0.00",
      discountAmount: "0.00",
      discountedMerchandiseTotal: "450.00",
      shippingCost: "0.00",
      orderTotal: "450.00",
      allocations: [["w", 3]],
    });
    expect(estimate.allocations[0]?.distanceKm).toBe(0);
  });

  test("insufficient stock retains merchandise and discount with null shipping and total", () => {
    const estimate = estimateOrder({ quantity: asQuantity(30), destination: destinationAt(0, 0) }, [
      { warehouseId: "w", warehouseName: "Paris", latitude: 0, longitude: 0, available: 29 },
      { warehouseId: "empty", warehouseName: "Warsaw", latitude: 0, longitude: 1, available: 0 },
    ]);
    expect(summarise(estimate)).toEqual({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      merchandiseSubtotal: "4500.00",
      discountRate: "0.05",
      discountAmount: "225.00",
      discountedMerchandiseTotal: "4275.00",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });
  });

  test("zero inventory is insufficient stock", () => {
    expect(
      estimateOrder({ quantity: asQuantity(1), destination: destinationAt(0, 0) }, []).reason,
    ).toBe("INSUFFICIENT_STOCK");
  });

  describe("shipping limit after rounding (1 unit: limit is exactly 22.50)", () => {
    const estimateAtKm = (km: number) =>
      estimateOrder(
        { quantity: asQuantity(1), destination: destinationAt(0, longitudeForKm(km)) },
        [{ warehouseId: "w", warehouseName: "Paris", latitude: 0, longitude: 0, available: 1 }],
      );

    test("below the limit is valid", () => {
      const estimate = estimateAtKm(6160); // 22.484 -> 22.48
      expect(estimate.shippingCost?.toString()).toBe("22.48");
      expect(estimate.valid).toBe(true);
      expect(estimate.orderTotal?.toString()).toBe("172.48");
    });

    test("rounding to exactly the limit is valid even when the unrounded cost is above it", () => {
      const estimate = estimateAtKm(6165.2); // 22.50298 -> 22.50
      expect(estimate.shippingCost?.toString()).toBe("22.50");
      expect(estimate.valid).toBe(true);
      expect(estimate.reason).toBeNull();
      expect(estimate.orderTotal?.toString()).toBe("172.50");
    });

    test("above the limit is invalid and retains all amounts and allocations", () => {
      const estimate = estimateAtKm(6166.5); // 22.507 -> 22.51
      expect(summarise(estimate)).toEqual({
        valid: false,
        reason: "SHIPPING_EXCEEDS_LIMIT",
        merchandiseSubtotal: "150.00",
        discountRate: "0.00",
        discountAmount: "0.00",
        discountedMerchandiseTotal: "150.00",
        shippingCost: "22.51",
        orderTotal: "172.51",
        allocations: [["w", 1]],
      });
    });
  });

  test("uses the PRD warehouses nearest-first with a split allocation", () => {
    const destination = destinationAt(13.75, 100.5); // Bangkok
    const estimate = estimateOrder({ quantity: asQuantity(500), destination }, PRD_WAREHOUSES);
    expect(summarise(estimate)).toEqual({
      valid: true,
      reason: null,
      merchandiseSubtotal: "75000.00",
      discountRate: "0.20",
      discountAmount: "15000.00",
      discountedMerchandiseTotal: "60000.00",
      shippingCost: "5002.43",
      orderTotal: "65002.43",
      allocations: [
        ["wh-6-hong-kong", 419],
        ["wh-5-warsaw", 81],
      ],
    });
  });

  test("the whole PRD inventory can be exhausted but not exceeded", () => {
    const total = PRD_WAREHOUSES.reduce((sum, warehouse) => sum + warehouse.available, 0);
    expect(total).toBe(2556);
    const exact = estimateOrder(
      { quantity: asQuantity(total), destination: destinationAt(0, 0) },
      PRD_WAREHOUSES,
    );
    expect(exact.allocations).toHaveLength(6);
    expect(exact.allocations.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(total);
    const over = estimateOrder(
      { quantity: asQuantity(total + 1), destination: destinationAt(0, 0) },
      PRD_WAREHOUSES,
    );
    expect(over.reason).toBe("INSUFFICIENT_STOCK");
  });

  test("throws AMOUNT_OUT_OF_RANGE when an excessive-shipping total cannot be stored", () => {
    const quantity = 60_000_000;
    const run = () =>
      estimateOrder({ quantity: asQuantity(quantity), destination: destinationAt(0, 0) }, [
        {
          warehouseId: "antipode",
          warehouseName: "Antipode",
          latitude: 0,
          longitude: 180,
          available: quantity,
        },
      ]);
    expect(run).toThrow(DomainError);
    expect(run).toThrow(/exceeds NUMERIC/);
  });

  test("returns a frozen estimate", () => {
    const estimate = estimateOrder(
      { quantity: asQuantity(1), destination: destinationAt(0, 0) },
      PRD_WAREHOUSES,
    );
    expect(Object.isFrozen(estimate)).toBe(true);
    expect(Object.isFrozen(estimate.allocations)).toBe(true);
  });
});

describe("published unit price and shipping limit", () => {
  const WAREHOUSE = {
    warehouseId: "w",
    warehouseName: "Paris",
    latitude: 0,
    longitude: 0,
    available: 30,
  } satisfies WarehouseStock;

  const estimateAt = (quantity: number, km = 0) =>
    estimateOrder(
      { quantity: asQuantity(quantity), destination: destinationAt(0, longitudeForKm(km)) },
      [WAREHOUSE],
    );

  // One per variant: 30 units at the warehouse, 1 unit just past the limit,
  // and 31 units against 30 in stock.
  const valid = estimateAt(30);
  const exceeds = estimateAt(1, 6166.5);
  const insufficient = estimateAt(31);

  test("every variant carries the unit price the subtotal was calculated with", () => {
    for (const estimate of [valid, exceeds, insufficient]) {
      expect(estimate.unitPrice.toString()).toBe("150.00");
      expect(
        estimate.unitPrice
          .toDecimal()
          .times(estimate.quantity)
          .equals(estimate.merchandiseSubtotal.toDecimal()),
      ).toBe(true);
    }
  });

  test("a priced estimate publishes the truncated limit its shipping was tested against", () => {
    expect(valid.shippingLimit?.toString()).toBe("641.25"); // 15% of 4275.00
    expect(exceeds.shippingLimit?.toString()).toBe("22.50"); // 15% of 150.00
    for (const estimate of [valid, exceeds]) {
      expect(estimate.shippingLimit?.toString()).toBe(
        publishedShippingLimitFor(estimate.discountedMerchandiseTotal).toString(),
      );
    }
  });

  test("insufficient stock publishes no limit, alongside its other null amounts", () => {
    expect(insufficient.reason).toBe("INSUFFICIENT_STOCK");
    expect(insufficient.shippingLimit).toBeNull();
    expect(insufficient.shippingCost).toBeNull();
    expect(insufficient.orderTotal).toBeNull();
  });

  test("publishing the limit did not move the accept or reject boundary", () => {
    // Shipping equal to the published limit is still accepted and one cent
    // more is still rejected, as before either field was carried.
    const atLimit = estimateAt(1, 6165.2);
    expect(atLimit.shippingCost?.toString()).toBe("22.50");
    expect(atLimit.shippingLimit?.toString()).toBe("22.50");
    expect(atLimit.valid).toBe(true);
    expect(atLimit.reason).toBeNull();

    expect(exceeds.shippingCost?.toString()).toBe("22.51");
    expect(exceeds.valid).toBe(false);
    expect(exceeds.reason).toBe("SHIPPING_EXCEEDS_LIMIT");

    expect(valid.valid).toBe(true);
    expect(valid.shippingCost?.toString()).toBe("0.00");
  });
});

describe("unvalidated requests", () => {
  test.each([0, -1, 2.5, Number.NaN])("quantity %s is rejected at runtime", (value) => {
    expect(() =>
      estimateOrder({ quantity: asQuantity(value), destination: destinationAt(0, 0) }, []),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  test("an out-of-range destination is rejected at runtime", () => {
    expect(() =>
      estimateOrder({ quantity: asQuantity(1), destination: destinationAt(91, 0) }, []),
    ).toThrow(DomainError);
  });
});
