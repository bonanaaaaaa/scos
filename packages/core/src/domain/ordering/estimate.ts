/**
 * Domain service returning a value object: estimateOrder.
 *
 * Composes pricing, allocation and shipping into an Order Estimate. The
 * estimate has no identity, is not persisted, and is a three-way discriminated
 * result (valid, SHIPPING_EXCEEDS_LIMIT or INSUFFICIENT_STOCK).
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import type { OrderRequest } from "#domain/ordering/order-request";
import { type DiscountRate, priceMerchandise } from "#domain/pricing/pricing";
import { type Destination, geoPointSchema } from "#domain/shared/destination";
import { DomainError } from "#domain/shared/errors";
import type { Money } from "#domain/shared/money";
import { type Quantity, quantitySchema } from "#domain/shared/quantity";
import {
  type InventorySnapshot,
  type ShippingPlan,
  allocateNearestFirst,
} from "#domain/shipping/allocation";
import { isShippingWithinLimit, shippingCostFor } from "#domain/shipping/shipping";

export type EstimateRejectionReason = "INSUFFICIENT_STOCK" | "SHIPPING_EXCEEDS_LIMIT";

interface EstimateBase {
  readonly quantity: Quantity;
  readonly destination: Destination;
  readonly merchandiseSubtotal: Money;
  readonly discountRate: DiscountRate;
  readonly discountAmount: Money;
  readonly discountedMerchandiseTotal: Money;
}

export interface ValidOrderEstimate extends EstimateBase {
  readonly valid: true;
  readonly reason: null;
  readonly allocations: ShippingPlan;
  readonly shippingCost: Money;
  readonly orderTotal: Money;
}

export interface ShippingExceedsLimitEstimate extends EstimateBase {
  readonly valid: false;
  readonly reason: "SHIPPING_EXCEEDS_LIMIT";
  readonly allocations: ShippingPlan;
  readonly shippingCost: Money;
  readonly orderTotal: Money;
}

export interface InsufficientStockEstimate extends EstimateBase {
  readonly valid: false;
  readonly reason: "INSUFFICIENT_STOCK";
  readonly allocations: readonly [];
  readonly shippingCost: null;
  readonly orderTotal: null;
}

export type OrderEstimate =
  | ValidOrderEstimate
  | ShippingExceedsLimitEstimate
  | InsufficientStockEstimate;

/**
 * Calculates an Order Estimate against an immutable inventory snapshot. The
 * snapshot is not modified and nothing is reserved.
 *
 * For quantity q, discount rate r (highest tier with q ≥ threshold: 0, 0.05,
 * 0.10, 0.15, 0.20 at 0, 25, 50, 100, 250) and nearest-first allocations
 * (qᵢ units from warehouse i at dᵢ km, Σ qᵢ = q):
 *
 * ```text
 * subtotal   = 150 · q
 * discount   = subtotal · r
 * discounted = subtotal − discount
 * shipping   = round_half_up(Σᵢ qᵢ · 0.365 kg · 0.01 $/kg/km · dᵢ, 2)
 * total      = discounted + shipping
 * valid      ⇔ Σ qᵢ = q  ∧  shipping ≤ 0.15 · discounted
 * ```
 *
 * If available stock is below q the estimate is INSUFFICIENT_STOCK with null
 * shipping and total; if shipping exceeds the limit it is
 * SHIPPING_EXCEEDS_LIMIT with every amount retained.
 *
 * Business rejections are returned, never thrown. Every throw is a DomainError
 * that signals a problem on our side and maps to a server error (HTTP 500), per
 * "Error handling" in packages/core/README.md:
 *
 * - `INVALID_REQUEST`: the request did not come from `orderRequestSchema` (for
 *   example a cast, unvalidated quantity or destination).
 * - `INVALID_INVENTORY`: the inventory snapshot is corrupt (empty or duplicate
 *   warehouse IDs, invalid coordinates, or negative or fractional stock).
 * - `AMOUNT_OUT_OF_RANGE`: a SHIPPING_EXCEEDS_LIMIT estimate whose order total
 *   would overflow NUMERIC(12, 2). Valid and INSUFFICIENT_STOCK estimates cannot
 *   overflow; this needs roughly 51.8 million or more units in stock, allocated
 *   at near-antipodal distance.
 */
export function estimateOrder(request: OrderRequest, inventory: InventorySnapshot): OrderEstimate {
  const { quantity, destination } = request;
  // The brands are compile-time only; re-check so unbranded callers cannot
  // obtain a "valid" estimate for a non-positive or fractional quantity.
  if (
    !quantitySchema.safeParse(quantity).success ||
    !geoPointSchema.safeParse(destination).success
  ) {
    throw new DomainError("INVALID_REQUEST", "Order request was not validated.");
  }
  const base: EstimateBase = { quantity, destination, ...priceMerchandise(quantity) };

  const allocations = allocateNearestFirst(quantity, destination, inventory);
  if (allocations === null) {
    return Object.freeze({
      ...base,
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      allocations: Object.freeze([]) as readonly [],
      shippingCost: null,
      orderTotal: null,
    });
  }

  const shippingCost = shippingCostFor(allocations);
  const orderTotal = base.discountedMerchandiseTotal.plus(shippingCost);
  if (!isShippingWithinLimit(shippingCost, base.discountedMerchandiseTotal)) {
    return Object.freeze({
      ...base,
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      allocations,
      shippingCost,
      orderTotal,
    });
  }
  return Object.freeze({
    ...base,
    valid: true,
    reason: null,
    allocations,
    shippingCost,
    orderTotal,
  });
}
