import { type InventorySnapshot, type ShippingPlan, allocateNearestFirst } from "./allocation";
import { type Destination, isValidGeoPoint } from "./destination";
import { DomainError } from "./errors";
import type { Money } from "./money";
import {
  type DiscountRate,
  isShippingWithinLimit,
  priceMerchandise,
  shippingCostFor,
} from "./pricing";
import { type Quantity, parseQuantity } from "./quantity";

export type EstimateRejectionReason = "INSUFFICIENT_STOCK" | "SHIPPING_EXCEEDS_LIMIT";

export interface OrderRequest {
  readonly quantity: Quantity;
  readonly destination: Destination;
}

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
 * Throws DomainError AMOUNT_OUT_OF_RANGE if shipping or the order total would
 * exceed NUMERIC(12, 2); that needs tens of millions of units in stock.
 */
export function estimateOrder(request: OrderRequest, inventory: InventorySnapshot): OrderEstimate {
  const { quantity, destination } = request;
  // The brands are compile-time only; re-check so unbranded callers cannot
  // obtain a "valid" estimate for a non-positive or fractional quantity.
  if (!parseQuantity(quantity).ok || !isValidGeoPoint(destination)) {
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
