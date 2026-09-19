import { describe, expect, test } from "vitest";

import { type OrderEstimate, estimateOrder } from "../domain/ordering/estimate";
import { type OrderRequest, orderRequestSchema } from "../domain/ordering/order-request";
import { DomainError } from "../domain/shared/errors";
import type { InventorySnapshot, WarehouseStock } from "../domain/shipping/allocation";

import type { InventoryReader } from "./ports/inventory-reader";
import { createVerifyOrder } from "./verify-order";

const PRD_WAREHOUSES: readonly WarehouseStock[] = [
  { warehouseId: "wh-1-los-angeles", latitude: 33.9425, longitude: -118.408056, available: 355 },
  { warehouseId: "wh-2-new-york", latitude: 40.639722, longitude: -73.778889, available: 578 },
  { warehouseId: "wh-3-sao-paulo", latitude: -23.435556, longitude: -46.473056, available: 265 },
  { warehouseId: "wh-4-paris", latitude: 49.009722, longitude: 2.547778, available: 694 },
  { warehouseId: "wh-5-warsaw", latitude: 52.165833, longitude: 20.967222, available: 245 },
  { warehouseId: "wh-6-hong-kong", latitude: 22.308889, longitude: 113.914444, available: 419 },
];

const BANGKOK = { latitude: 13.75, longitude: 100.5 };
const SYDNEY = { latitude: -33.8688, longitude: 151.2093 };

const requestFor = (quantity: number, point: { latitude: number; longitude: number }) =>
  orderRequestSchema.parse({ quantity, ...point });

/**
 * In-memory inventory port. It hands out a fresh frozen snapshot of its current
 * stock on every read and counts the reads, so tests can change stock between
 * verifications and prove that nothing is cached.
 */
function createFakeInventoryReader(initial: readonly WarehouseStock[] = PRD_WAREHOUSES) {
  let warehouses = initial.map((warehouse) => ({ ...warehouse }));
  let reads = 0;
  const reader: InventoryReader = {
    readInventorySnapshot: async () => {
      reads += 1;
      return Object.freeze(warehouses.map((warehouse) => Object.freeze({ ...warehouse })));
    },
  };
  return {
    reader,
    get reads() {
      return reads;
    },
    setAvailable(warehouseId: string, available: number) {
      warehouses = warehouses.map((warehouse) =>
        warehouse.warehouseId === warehouseId ? { ...warehouse, available } : warehouse,
      );
    },
  };
}

const summarise = (estimate: OrderEstimate) => ({
  valid: estimate.valid,
  reason: estimate.reason,
  quantity: estimate.quantity,
  destination: estimate.destination,
  merchandiseSubtotal: estimate.merchandiseSubtotal.toString(),
  discountRate: estimate.discountRate,
  discountAmount: estimate.discountAmount.toString(),
  discountedMerchandiseTotal: estimate.discountedMerchandiseTotal.toString(),
  shippingCost: estimate.shippingCost?.toString() ?? null,
  orderTotal: estimate.orderTotal?.toString() ?? null,
  allocations: estimate.allocations.map(({ warehouseId, quantity }) => [warehouseId, quantity]),
});

describe("VerifyOrder estimates", () => {
  test("a valid estimate exposes exact amounts and nearest-first allocations", async () => {
    const inventory = createFakeInventoryReader();
    const verifyOrder = createVerifyOrder({ inventoryReader: inventory.reader });

    const estimate = await verifyOrder(requestFor(500, BANGKOK));

    // Hong Kong 419 x 1706.375 km + Warsaw 81 x 8093.304 km, at 0.00365 $/unit/km.
    expect(summarise(estimate)).toStrictEqual({
      valid: true,
      reason: null,
      quantity: 500,
      destination: BANGKOK,
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
    const distances = estimate.allocations.map((allocation) => allocation.distanceKm);
    expect(distances).toStrictEqual([...distances].sort((left, right) => left - right));
    expect(distances[0]).toBeCloseTo(1706.375, 3);
  });

  test("excessive shipping is invalid but keeps allocations, shipping cost and order total", async () => {
    const inventory = createFakeInventoryReader();
    const verifyOrder = createVerifyOrder({ inventoryReader: inventory.reader });

    const estimate = await verifyOrder(requestFor(1, SYDNEY));

    // Nearest stock is Hong Kong at 7388.905 km: 26.97 shipping against a
    // limit of 15% x 150.00 = 22.50.
    expect(summarise(estimate)).toStrictEqual({
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      quantity: 1,
      destination: SYDNEY,
      merchandiseSubtotal: "150.00",
      discountRate: "0.00",
      discountAmount: "0.00",
      discountedMerchandiseTotal: "150.00",
      shippingCost: "26.97",
      orderTotal: "176.97",
      allocations: [["wh-6-hong-kong", 1]],
    });
    expect(estimate.shippingCost).not.toBeNull();
    expect(estimate.orderTotal).not.toBeNull();
  });

  test("insufficient stock keeps merchandise amounts with no allocations and null shipping and total", async () => {
    const inventory = createFakeInventoryReader();
    const verifyOrder = createVerifyOrder({ inventoryReader: inventory.reader });

    // One more than the 2556 units held across the six warehouses.
    const estimate = await verifyOrder(requestFor(2557, BANGKOK));

    expect(summarise(estimate)).toStrictEqual({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      quantity: 2557,
      destination: BANGKOK,
      merchandiseSubtotal: "383550.00",
      discountRate: "0.20",
      discountAmount: "76710.00",
      discountedMerchandiseTotal: "306840.00",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });
    expect(estimate.shippingCost).toBeNull();
    expect(estimate.orderTotal).toBeNull();
    expect(estimate.allocations).toStrictEqual([]);
  });
});

describe("VerifyOrder orchestration", () => {
  test("reads the inventory once per verification and returns the shared calculation unchanged", async () => {
    const snapshot: InventorySnapshot = Object.freeze(
      PRD_WAREHOUSES.map((warehouse) => Object.freeze({ ...warehouse })),
    );
    let reads = 0;
    const verifyOrder = createVerifyOrder({
      inventoryReader: {
        readInventorySnapshot: async () => {
          reads += 1;
          return snapshot;
        },
      },
    });
    expect(reads).toBe(0);

    for (const request of [
      requestFor(500, BANGKOK),
      requestFor(1, SYDNEY),
      requestFor(2557, BANGKOK),
    ]) {
      const before = reads;
      const estimate = await verifyOrder(request);
      expect(reads).toBe(before + 1);
      // Money keeps its amount in a private field that structural equality
      // cannot see, so compare the serialised form (Money.toJSON, unrounded
      // allocation distances included) as well.
      const expected = estimateOrder(request, snapshot);
      expect(estimate).toStrictEqual(expected);
      expect(JSON.parse(JSON.stringify(estimate))).toStrictEqual(
        JSON.parse(JSON.stringify(expected)),
      );
      expect(Object.isFrozen(estimate)).toBe(true);
    }
  });

  test("a deep-frozen snapshot from the port is accepted and left unchanged", async () => {
    const snapshot: InventorySnapshot = Object.freeze(
      PRD_WAREHOUSES.map((warehouse) => Object.freeze({ ...warehouse })),
    );
    const copy = structuredClone(snapshot);
    const verifyOrder = createVerifyOrder({
      inventoryReader: { readInventorySnapshot: async () => snapshot },
    });

    await verifyOrder(requestFor(500, BANGKOK));
    await verifyOrder(requestFor(2557, BANGKOK));

    expect(snapshot).toStrictEqual(copy);
    expect(snapshot.map((warehouse) => warehouse.warehouseId)).toStrictEqual(
      PRD_WAREHOUSES.map((warehouse) => warehouse.warehouseId),
    );
  });

  test("repeated verification observes changed inventory and never honours an earlier estimate", async () => {
    const inventory = createFakeInventoryReader();
    const verifyOrder = createVerifyOrder({ inventoryReader: inventory.reader });
    const request = requestFor(500, BANGKOK);

    const first = await verifyOrder(request);
    expect(summarise(first)).toMatchObject({
      valid: true,
      shippingCost: "5002.43",
      allocations: [
        ["wh-6-hong-kong", 419],
        ["wh-5-warsaw", 81],
      ],
    });

    // Another order takes Hong Kong stock: the same request now costs more.
    inventory.setAvailable("wh-6-hong-kong", 300);
    const costlier = await verifyOrder(request);
    expect(summarise(costlier)).toMatchObject({
      valid: true,
      shippingCost: "7776.59",
      orderTotal: "67776.59",
      allocations: [
        ["wh-6-hong-kong", 300],
        ["wh-5-warsaw", 200],
      ],
    });

    // Less again: a third warehouse is needed and shipping passes the limit.
    inventory.setAvailable("wh-6-hong-kong", 100);
    const excessive = await verifyOrder(request);
    expect(summarise(excessive)).toMatchObject({
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      shippingCost: "13192.63",
      orderTotal: "73192.63",
      allocations: [
        ["wh-6-hong-kong", 100],
        ["wh-5-warsaw", 245],
        ["wh-4-paris", 155],
      ],
    });

    // Stock drained below the request: it can no longer be fulfilled at all.
    for (const warehouse of PRD_WAREHOUSES) {
      inventory.setAvailable(warehouse.warehouseId, 0);
    }
    inventory.setAvailable("wh-1-los-angeles", 499);
    const insufficient = await verifyOrder(request);
    expect(summarise(insufficient)).toMatchObject({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      discountedMerchandiseTotal: "60000.00",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });

    expect(inventory.reads).toBe(4);
    // The earlier estimate is an immutable value; it is simply out of date.
    expect(first.valid).toBe(true);
  });
});

describe("VerifyOrder failures", () => {
  test("an inventory port failure rejects with the original error", async () => {
    const failure = new Error("connection refused");
    const verifyOrder = createVerifyOrder({
      inventoryReader: { readInventorySnapshot: () => Promise.reject(failure) },
    });

    await expect(verifyOrder(requestFor(1, BANGKOK))).rejects.toBe(failure);
  });

  test("a corrupt snapshot surfaces DomainError INVALID_INVENTORY instead of an estimate", async () => {
    const inventory = createFakeInventoryReader([
      { warehouseId: "wh-1-los-angeles", latitude: 33.9425, longitude: -118.408056, available: -1 },
    ]);
    const verifyOrder = createVerifyOrder({ inventoryReader: inventory.reader });

    const error: unknown = await verifyOrder(requestFor(1, BANGKOK)).then(
      () => expect.fail("expected verification to reject"),
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: "INVALID_INVENTORY" });
    expect(inventory.reads).toBe(1);
  });

  test("an unvalidated request surfaces DomainError INVALID_REQUEST", async () => {
    const inventory = createFakeInventoryReader();
    const verifyOrder = createVerifyOrder({ inventoryReader: inventory.reader });
    const unvalidated = { quantity: 0, destination: BANGKOK } as unknown as OrderRequest;

    await expect(verifyOrder(unvalidated)).rejects.toMatchObject({
      name: "DomainError",
      code: "INVALID_REQUEST",
    });
  });
});
