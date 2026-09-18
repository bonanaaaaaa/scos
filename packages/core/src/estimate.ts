import { type InventorySnapshot, type ShippingPlan, allocateNearestFirst } from "./allocation.js";
import { type Destination, isValidGeoPoint } from "./destination.js";
import { DomainError } from "./errors.js";
import type { Money } from "./money.js";
import {
  type DiscountRate,
  isShippingWithinLimit,
  priceMerchandise,
  shippingCostFor,
} from "./pricing.js";
import { type Quantity, parseQuantity } from "./quantity.js";

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
