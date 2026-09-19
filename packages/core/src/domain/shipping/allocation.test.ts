import { describe, expect, test } from "vitest";

import type { Destination } from "../shared/destination";
import { DomainError } from "../shared/errors";
import type { Quantity } from "../shared/quantity";

import { type WarehouseStock, allocateNearestFirst } from "./allocation";

const destination = { latitude: 0, longitude: 0 } as Destination;
const asQuantity = (value: number): Quantity => value as Quantity;

/** A warehouse stock entry; latitude defaults to the equator (the destination's latitude). */
const warehouse = ({
  id,
  latitude = 0,
  longitude,
  available,
}: {
  id: string;
  latitude?: number;
  longitude: number;
  available: number;
}): WarehouseStock => ({ warehouseId: id, latitude, longitude, available });

describe("allocateNearestFirst", () => {
  test("takes everything from the nearest warehouse when it suffices", () => {
    const plan = allocateNearestFirst(asQuantity(5), destination, [
      warehouse({ id: "far", longitude: 20, available: 100 }),
      warehouse({ id: "near", longitude: 1, available: 10 }),
    ]);
    expect(plan?.map(({ warehouseId, quantity }) => [warehouseId, quantity])).toEqual([
      ["near", 5],
    ]);
  });

  test("splits across warehouses nearest-first without exceeding stock", () => {
    const inventory = [
      warehouse({ id: "c", longitude: 30, available: 100 }),
      warehouse({ id: "a", longitude: 10, available: 3 }),
      warehouse({ id: "b", longitude: 20, available: 4 }),
    ];
    const plan = allocateNearestFirst(asQuantity(10), destination, inventory);
    expect(plan?.map(({ warehouseId, quantity }) => [warehouseId, quantity])).toEqual([
      ["a", 3],
      ["b", 4],
      ["c", 3],
    ]);
    expect(plan?.[0]?.distanceKm).toBeLessThan(plan?.[1]?.distanceKm ?? 0);
  });

  test("skips zero-stock warehouses even when nearest", () => {
    const plan = allocateNearestFirst(asQuantity(2), destination, [
      warehouse({ id: "empty", longitude: 0, available: 0 }),
      warehouse({ id: "x", longitude: 5, available: 2 }),
    ]);
    expect(plan?.map((entry) => entry.warehouseId)).toEqual(["x"]);
  });

  test("exhausts stock exactly", () => {
    const plan = allocateNearestFirst(asQuantity(7), destination, [
      warehouse({ id: "a", longitude: 1, available: 3 }),
      warehouse({ id: "b", longitude: 2, available: 4 }),
    ]);
    expect(plan?.map((entry) => entry.quantity)).toEqual([3, 4]);
  });

  test("returns null for insufficient stock, including an empty or all-zero snapshot", () => {
    expect(
      allocateNearestFirst(asQuantity(8), destination, [
        warehouse({ id: "a", longitude: 1, available: 3 }),
        warehouse({ id: "b", longitude: 2, available: 4 }),
      ]),
    ).toBeNull();
    expect(allocateNearestFirst(asQuantity(1), destination, [])).toBeNull();
    expect(
      allocateNearestFirst(asQuantity(1), destination, [
        warehouse({ id: "a", longitude: 1, available: 0 }),
      ]),
    ).toBeNull();
  });

  test("breaks equal-distance ties by warehouse ID regardless of input order", () => {
    // Mirror-image warehouses are exactly equidistant from the destination.
    const west = warehouse({ id: "wh-b", longitude: -10, available: 5 });
    const east = warehouse({ id: "wh-a", longitude: 10, available: 5 });
    const north = warehouse({ id: "wh-c", latitude: 10, longitude: 0, available: 5 });
    for (const inventory of [
      [west, east, north],
      [north, west, east],
      [east, north, west],
    ]) {
      const plan = allocateNearestFirst(asQuantity(12), destination, inventory);
      expect(plan?.map(({ warehouseId, quantity }) => [warehouseId, quantity])).toEqual([
        ["wh-a", 5],
        ["wh-b", 5],
        ["wh-c", 2],
      ]);
    }
  });

  test("uses code-unit ordering for tie-breaks, not locale ordering", () => {
    const plan = allocateNearestFirst(asQuantity(1), destination, [
      warehouse({ id: "a", longitude: -10, available: 1 }),
      warehouse({ id: "B", longitude: 10, available: 1 }),
    ]);
    expect(plan?.[0]?.warehouseId).toBe("B");
  });

  test("does not mutate the inventory snapshot and returns frozen allocations", () => {
    const inventory = Object.freeze([
      Object.freeze(warehouse({ id: "b", longitude: 2, available: 4 })),
      Object.freeze(warehouse({ id: "a", longitude: 1, available: 3 })),
    ]);
    const plan = allocateNearestFirst(asQuantity(5), destination, inventory);
    expect(inventory.map((entry) => entry.warehouseId)).toEqual(["b", "a"]);
    expect(inventory.map((entry) => entry.available)).toEqual([4, 3]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan?.[0])).toBe(true);
  });

  test.each([
    [
      [warehouse({ id: "a", longitude: 1, available: -1 })],
      /expected number to be >=0\n.*\[0\]\.available/,
    ],
    [
      [warehouse({ id: "a", longitude: 1, available: 1.5 })],
      /expected int\b.*\n.*\[0\]\.available/,
    ],
    [
      [
        warehouse({ id: "a", longitude: 1, available: 1 }),
        warehouse({ id: "a", longitude: 2, available: 1 }),
      ],
      /Duplicate warehouse ID "a"; IDs must be unique\.\n.*\[1\]\.warehouseId/,
    ],
    [
      [warehouse({ id: "", longitude: 1, available: 1 })],
      /expected string to have >=1 characters\n.*\[0\]\.warehouseId/,
    ],
    [
      [warehouse({ id: "a", longitude: 181, available: 1 })],
      /expected number to be <=180\n.*\[0\]\.longitude/,
    ],
    [
      [warehouse({ id: "a", longitude: Number.NaN, available: 1 })],
      /received NaN\n.*\[0\]\.longitude/,
    ],
  ])("rejects an invalid snapshot %#", (inventory, message) => {
    expect(() => allocateNearestFirst(asQuantity(1), destination, inventory)).toThrow(DomainError);
    expect(() => allocateNearestFirst(asQuantity(1), destination, inventory)).toThrow(message);
  });

  test("reports every problem in an invalid snapshot at once", () => {
    const inventory = [
      warehouse({ id: "a", longitude: 1, available: 1 }),
      warehouse({ id: "a", latitude: 95, longitude: 1, available: -2 }),
      warehouse({ id: "", longitude: 1, available: 1 }),
    ];
    let thrown: unknown;
    try {
      allocateNearestFirst(asQuantity(1), destination, inventory);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const { code, message } = thrown as DomainError;
    expect(code).toBe("INVALID_INVENTORY");
    expect(message).toMatch(/expected number to be <=90\n.*\[1\]\.latitude/);
    expect(message).toMatch(/expected number to be >=0\n.*\[1\]\.available/);
    expect(message).toMatch(/expected string to have >=1 characters\n.*\[2\]\.warehouseId/);
    expect(message).toMatch(
      /Duplicate warehouse ID "a"; IDs must be unique\.\n.*\[1\]\.warehouseId/,
    );
  });
});
