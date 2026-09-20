/**
 * Use case: VerifyOrder.
 *
 * Advisory verification of an Order Request against current Warehouse
 * Inventory. It loads one inventory snapshot through the {@link InventoryReader}
 * port and hands it to the shared domain calculation, `estimateOrder`, which
 * submission also uses.
 *
 * @see docs/architecture.md, "Application layer"
 * @see docs/adr/0001-advisory-verification.md
 * @module
 */

import { type OrderEstimate, estimateOrder } from "#domain/ordering/estimate";
import type { OrderRequest } from "#domain/ordering/order-request";

import type { InventoryReader } from "#application/ports/inventory-reader";

/**
 * Returns the Order Estimate for a validated Order Request.
 *
 * The estimate is advisory (ADR 0001): it reserves and writes nothing, and it
 * does not promise later acceptance. Inventory can change before submission,
 * which recalculates against the stock it locks, so a previously valid estimate
 * may cost more or be rejected when submitted.
 *
 * Business rejections (`INSUFFICIENT_STOCK`, `SHIPPING_EXCEEDS_LIMIT`) are
 * returned as `valid: false` estimates, never thrown. The promise rejects only
 * for problems on our side: an error from the inventory port, or a
 * `DomainError` from `estimateOrder` (an unvalidated request, a corrupt
 * snapshot, or an unstorable amount).
 */
export type VerifyOrder = (request: OrderRequest) => Promise<OrderEstimate>;

export interface VerifyOrderDependencies {
  readonly inventoryReader: InventoryReader;
}

/**
 * Builds the VerifyOrder use case over an inventory port. Every call reads the
 * inventory snapshot exactly once and keeps nothing between calls, so repeated
 * verification always observes current stock.
 */
export function createVerifyOrder({ inventoryReader }: VerifyOrderDependencies): VerifyOrder {
  return async function verifyOrder(request) {
    const inventory = await inventoryReader.readInventorySnapshot();
    return estimateOrder(request, inventory);
  };
}
