import { describe, expect, test } from "vitest";

import { type WarehouseStock, allocateNearestFirst } from "./allocation";
import type { Destination } from "./destination";
import { DomainError } from "./errors";
import type { Quantity } from "./quantity";

const destination = { latitude: 0, longitude: 0 } as Destination;
const q = (value: number): Quantity => value as Quantity;
const stock = (
  warehouseId: string,
  longitude: number,
  available: number,
  latitude = 0,
): WarehouseStock => ({ warehouseId, latitude, longitude, available });

describe("allocateNearestFirst", () => {
  test("takes everything from the nearest warehouse when it suffices", () => {
    const plan = allocateNearestFirst(q(5), destination, [
      stock("far", 20, 100),
      stock("near", 1, 10),
    ]);
    expect(plan?.map(({ warehouseId, quantity }) => [warehouseId, quantity])).toEqual([
      ["near", 5],
    ]);
  });

  test("splits across warehouses nearest-first without exceeding stock", () => {
    const inventory = [stock("c", 30, 100), stock("a", 10, 3), stock("b", 20, 4)];
    const plan = allocateNearestFirst(q(10), destination, inventory);
    expect(plan?.map(({ warehouseId, quantity }) => [warehouseId, quantity])).toEqual([
      ["a", 3],
      ["b", 4],
      ["c", 3],
    ]);
    expect(plan?.[0]?.distanceKm).toBeLessThan(plan?.[1]?.distanceKm ?? 0);
  });

  test("skips zero-stock warehouses even when nearest", () => {
    const plan = allocateNearestFirst(q(2), destination, [stock("empty", 0, 0), stock("x", 5, 2)]);
    expect(plan?.map((entry) => entry.warehouseId)).toEqual(["x"]);
  });

  test("exhausts stock exactly", () => {
    const plan = allocateNearestFirst(q(7), destination, [stock("a", 1, 3), stock("b", 2, 4)]);
    expect(plan?.map((entry) => entry.quantity)).toEqual([3, 4]);
  });

  test("returns null for insufficient stock, including an empty or all-zero snapshot", () => {
    expect(
      allocateNearestFirst(q(8), destination, [stock("a", 1, 3), stock("b", 2, 4)]),
    ).toBeNull();
    expect(allocateNearestFirst(q(1), destination, [])).toBeNull();
    expect(allocateNearestFirst(q(1), destination, [stock("a", 1, 0)])).toBeNull();
  });

  test("breaks equal-distance ties by warehouse ID regardless of input order", () => {
    // Mirror-image warehouses are exactly equidistant from the destination.
    const west = stock("wh-b", -10, 5);
    const east = stock("wh-a", 10, 5);
    const north = stock("wh-c", 0, 5, 10);
    for (const inventory of [
      [west, east, north],
      [north, west, east],
      [east, north, west],
    ]) {
      const plan = allocateNearestFirst(q(12), destination, inventory);
      expect(plan?.map(({ warehouseId, quantity }) => [warehouseId, quantity])).toEqual([
        ["wh-a", 5],
        ["wh-b", 5],
        ["wh-c", 2],
      ]);
    }
  });

  test("uses code-unit ordering for tie-breaks, not locale ordering", () => {
    const plan = allocateNearestFirst(q(1), destination, [stock("a", -10, 1), stock("B", 10, 1)]);
    expect(plan?.[0]?.warehouseId).toBe("B");
  });

  test("does not mutate the inventory snapshot and returns frozen allocations", () => {
    const inventory = Object.freeze([
      Object.freeze(stock("b", 2, 4)),
      Object.freeze(stock("a", 1, 3)),
    ]);
    const plan = allocateNearestFirst(q(5), destination, inventory);
    expect(inventory.map((entry) => entry.warehouseId)).toEqual(["b", "a"]);
    expect(inventory.map((entry) => entry.available)).toEqual([4, 3]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan?.[0])).toBe(true);
  });

  test.each([
    [[stock("a", 1, -1)], /non-negative integer/],
    [[stock("a", 1, 1.5)], /non-negative integer/],
    [[stock("a", 1, 1), stock("a", 2, 1)], /unique/],
    [[stock("", 1, 1)], /unique/],
    [[stock("a", 181, 1)], /coordinates/],
    [[stock("a", Number.NaN, 1)], /coordinates/],
  ])("rejects an invalid snapshot %#", (inventory, message) => {
    expect(() => allocateNearestFirst(q(1), destination, inventory)).toThrow(DomainError);
    expect(() => allocateNearestFirst(q(1), destination, inventory)).toThrow(message);
  });
});
