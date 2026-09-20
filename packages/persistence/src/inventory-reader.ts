import type { InventoryReader, InventorySnapshot } from "@scos/core";

/** The columns the snapshot needs; timestamps and relations are not read. */
const inventoryColumns = {
  id: true,
  name: true,
  latitude: true,
  longitude: true,
  stock: true,
} as const;

/** Stable ID order, matching the order in which submission locks warehouse rows. */
const inventoryOrder = { id: "asc" } as const;

interface WarehouseInventoryRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly stock: number;
}

/**
 * The part of the Prisma client the reader uses. A `PrismaClient` from
 * createPrismaClient satisfies it; nothing that can write is reachable
 * through it.
 */
export interface InventoryReaderClient {
  readonly warehouse: {
    findMany(args: {
      readonly select: typeof inventoryColumns;
      readonly orderBy: typeof inventoryOrder;
    }): PromiseLike<readonly WarehouseInventoryRow[]>;
  };
}

/**
 * PostgreSQL implementation of core's InventoryReader port, used by advisory
 * verification (ADR 0001).
 *
 * Every read is exactly one `SELECT` over `warehouses`. PostgreSQL runs a
 * single statement against one MVCC snapshot, taken when the statement starts
 * (READ COMMITTED, the default, and every stricter level), so all six stock
 * values come from the same committed state: a concurrent submission that
 * deducts from several warehouses is seen either completely or not at all.
 * That makes an explicit transaction unnecessary; one would only be needed to
 * keep several statements coherent with each other. The warehouse name is read
 * live with the stock: an estimate is advisory and computed from a fresh
 * snapshot, so the current name is the right name to return.
 *
 * The read takes no row lock (`FOR UPDATE` / `FOR SHARE` are reserved for
 * submission), reserves nothing and writes nothing, so it never blocks or is
 * blocked by a submission and leaves `updated_at` untouched. Nothing is cached:
 * each call queries again. Prisma row types stay inside this adapter; core
 * receives a frozen InventorySnapshot.
 */
export function createPrismaInventoryReader(prisma: InventoryReaderClient): InventoryReader {
  return {
    async readInventorySnapshot(): Promise<InventorySnapshot> {
      const rows = await prisma.warehouse.findMany({
        select: inventoryColumns,
        orderBy: inventoryOrder,
      });
      return Object.freeze(
        rows.map(({ id, name, latitude, longitude, stock }) =>
          Object.freeze({
            warehouseId: id,
            warehouseName: name,
            latitude,
            longitude,
            available: stock,
          }),
        ),
      );
    },
  };
}
