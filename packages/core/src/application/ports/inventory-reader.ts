/**
 * Driven port: InventoryReader.
 *
 * Core owns this interface and never implements it; `packages/persistence`
 * provides the PostgreSQL adapter.
 *
 * @see docs/architecture.md, "Application layer"
 * @module
 */

import type { InventorySnapshot } from "#domain/shipping/allocation";

/**
 * Reads Warehouse Inventory for advisory verification.
 *
 * Contract for implementations:
 *
 * - **Coherent:** one call returns every warehouse's available stock as of a
 *   single point in time. Stock levels from different moments must never be
 *   combined into one snapshot.
 * - **Complete:** every warehouse appears exactly once, including those with no
 *   stock, with its unrounded coordinates.
 * - **Read-only:** no row is written, no stock is reserved or deducted, and no
 *   lock is taken or held after the call returns. Submission has its own
 *   locking read and does not use this port.
 * - **Current:** each call reads again; implementations do not cache.
 *
 * Technical failures reject the promise. The returned snapshot is treated as
 * immutable by core.
 */
export interface InventoryReader {
  readInventorySnapshot(): Promise<InventorySnapshot>;
}
