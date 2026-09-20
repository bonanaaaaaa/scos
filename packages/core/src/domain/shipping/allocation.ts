/**
 * Domain service: Allocation.
 *
 * Stateless nearest-first allocation of an order across warehouses.
 * `WarehouseStock` / `InventorySnapshot` are a read model handed in through a
 * port: `Warehouse` is not a domain entity in core.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { z } from "zod";

import { type Destination, latitudeSchema, longitudeSchema } from "#domain/shared/destination";
import { DomainError } from "#domain/shared/errors";
import type { Quantity } from "#domain/shared/quantity";
import { haversineDistanceKm } from "#domain/shipping/distance";

/**
 * Invariant check for one warehouse's stock: a non-empty ID, valid
 * coordinates and a non-negative safe-integer available count.
 */
const warehouseStockSchema = z.object({
  warehouseId: z.string().min(1),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  available: z.number().int().nonnegative(),
});

/** Invariant check for a whole snapshot: every entry valid, IDs unique. */
const inventorySnapshotSchema = z.array(warehouseStockSchema).superRefine((warehouses, ctx) => {
  const seen = new Set<string>();
  for (const [index, { warehouseId }] of warehouses.entries()) {
    if (seen.has(warehouseId)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate warehouse ID "${warehouseId}"; IDs must be unique.`,
        path: [index, "warehouseId"],
      });
    }
    seen.add(warehouseId);
  }
});

/** One warehouse's available stock in an immutable inventory snapshot. */
export type WarehouseStock = Readonly<z.infer<typeof warehouseStockSchema>>;

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

/**
 * A corrupt snapshot is a data error on our side, not client input, so every
 * problem is reported in one DomainError and a ZodError never escapes.
 */
function assertValidSnapshot(inventory: InventorySnapshot): void {
  const result = inventorySnapshotSchema.safeParse(inventory);
  if (!result.success) {
    throw new DomainError("INVALID_INVENTORY", z.prettifyError(result.error));
  }
}

/** Plain code-unit comparison so ordering is locale-independent. */
function compareIds(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
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
  quantity: Quantity,
  destination: Destination,
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
  let remaining: number = quantity;
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

  // quantity >= 1 and total stock >= quantity, so the loop allocates at least
  // one warehouse and always drives `remaining` to zero.
  return Object.freeze(allocations) as readonly WarehouseAllocation[] as ShippingPlan;
}
