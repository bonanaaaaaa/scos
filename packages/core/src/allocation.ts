import { type GeoPoint, isValidGeoPoint } from "./destination.js";
import { haversineDistanceKm } from "./distance.js";
import { DomainError } from "./errors.js";

/** One warehouse's available stock in an immutable inventory snapshot. */
export interface WarehouseStock {
  readonly warehouseId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly available: number;
}

export type InventorySnapshot = readonly WarehouseStock[];

/** Units assigned to one warehouse, with its unrounded distance in km. */
export interface WarehouseAllocation {
  readonly warehouseId: string;
  readonly quantity: number;
  readonly distanceKm: number;
}

export type ShippingPlan = readonly [WarehouseAllocation, ...WarehouseAllocation[]];

interface RankedWarehouse {
  readonly warehouseId: string;
  readonly available: number;
  readonly distanceKm: number;
}

function assertValidSnapshot(inventory: InventorySnapshot): void {
  const seen = new Set<string>();
  for (const warehouse of inventory) {
    if (warehouse.warehouseId.length === 0 || seen.has(warehouse.warehouseId)) {
      throw new DomainError(
        "INVALID_INVENTORY",
        `Warehouse IDs must be non-empty and unique; received "${warehouse.warehouseId}".`,
      );
    }
    seen.add(warehouse.warehouseId);
    if (!Number.isSafeInteger(warehouse.available) || warehouse.available < 0) {
      throw new DomainError(
        "INVALID_INVENTORY",
        `Warehouse ${warehouse.warehouseId} available stock must be a non-negative integer.`,
      );
    }
    if (!isValidGeoPoint(warehouse)) {
      throw new DomainError(
        "INVALID_INVENTORY",
        `Warehouse ${warehouse.warehouseId} has invalid coordinates.`,
      );
    }
  }
}

/** Plain code-unit comparison so ordering is locale-independent. */
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Allocates the full quantity nearest-first, or returns null when total stock
 * cannot fulfil it (no partial allocation).
 *
 * Warehouses are ordered by distance ascending, then warehouse ID ascending for
 * deterministic equal-distance ties. Each takes min(remaining, available);
 * zero-stock warehouses are skipped and no warehouse exceeds its stock.
 *
 * Nearest-first greedy is the least-cost complete allocation because the cost
 * of each unit is linear in its warehouse's distance with an identical rate, so
 * moving any unit to a farther warehouse can never lower the total.
 */
export function allocateNearestFirst(
  quantity: number,
  destination: GeoPoint,
  inventory: InventorySnapshot,
): ShippingPlan | null {
  assertValidSnapshot(inventory);

  const totalAvailable = inventory.reduce((sum, warehouse) => sum + warehouse.available, 0);
  if (totalAvailable < quantity) {
    return null;
  }

  const ranked: RankedWarehouse[] = inventory
    .filter((warehouse) => warehouse.available > 0)
    .map((warehouse) => ({
      warehouseId: warehouse.warehouseId,
      available: warehouse.available,
      distanceKm: haversineDistanceKm(warehouse, destination),
    }))
    .sort(
      (left, right) =>
        left.distanceKm - right.distanceKm || compareIds(left.warehouseId, right.warehouseId),
    );

  const allocations: WarehouseAllocation[] = [];
  let remaining = quantity;
  for (const warehouse of ranked) {
    if (remaining === 0) break;
    const units = Math.min(remaining, warehouse.available);
    allocations.push(
      Object.freeze({
        warehouseId: warehouse.warehouseId,
        quantity: units,
        distanceKm: warehouse.distanceKm,
      }),
    );
    remaining -= units;
  }

  const [first, ...rest] = allocations;
  if (first === undefined || remaining !== 0) {
    return null;
  }
  return Object.freeze([first, ...rest]);
}
