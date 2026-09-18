import type { WarehouseAllocation, ShippingPlan } from "./allocation.js";
import type { Destination } from "./destination.js";
import { DomainError } from "./errors.js";
import { Money } from "./money.js";
import type { OrderEstimate } from "./estimate.js";
import { type DiscountRate, isShippingWithinLimit } from "./pricing.js";
import { UNIT_PRICE } from "./product.js";
import { type Quantity, MAX_QUANTITY } from "./quantity.js";

/** An accepted order. Amounts are immutable historical facts. */
export interface Order {
  readonly id: string;
  readonly orderNumber: string;
  readonly quantity: Quantity;
  readonly destination: Destination;
  readonly merchandiseSubtotal: Money;
  readonly discountRate: DiscountRate;
  readonly discountAmount: Money;
  readonly discountedMerchandiseTotal: Money;
  readonly shippingCost: Money;
  readonly orderTotal: Money;
  readonly allocations: ShippingPlan;
}

export interface CreateOrderInput {
  readonly id: string;
  readonly orderNumber: string;
  readonly estimate: OrderEstimate;
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new DomainError("INVALID_ORDER", message);
  }
}

function assertAllocations(quantity: number, allocations: readonly WarehouseAllocation[]): void {
  invariant(allocations.length > 0, "An order requires at least one warehouse allocation.");
  const warehouseIds = new Set<string>();
  let allocated = 0;
  for (const allocation of allocations) {
    invariant(
      Number.isSafeInteger(allocation.quantity) && allocation.quantity > 0,
      "Each allocation quantity must be a positive integer.",
    );
    invariant(
      Number.isFinite(allocation.distanceKm) && allocation.distanceKm >= 0,
      "Each allocation distance must be finite and non-negative.",
    );
    invariant(
      !warehouseIds.has(allocation.warehouseId),
      `Warehouse ${allocation.warehouseId} is allocated more than once.`,
    );
    warehouseIds.add(allocation.warehouseId);
    allocated += allocation.quantity;
  }
  invariant(allocated === quantity, "Allocations must sum to the ordered quantity.");
}

/**
 * Creates an accepted Order from a valid estimate and externally supplied
 * identifiers. Throws DomainError INVALID_ORDER if the estimate is not valid or
 * any accepted-order invariant does not hold. Money values already guarantee
 * cent scale and NUMERIC(12, 2) range.
 */
export function createOrder(input: CreateOrderInput): Order {
  const { id, orderNumber, estimate } = input;
  invariant(id.length > 0, "Order id is required.");
  invariant(orderNumber.length > 0, "Order number is required.");
  invariant(estimate.valid, `Only a valid estimate can become an order (${estimate.reason}).`);

  const { quantity, allocations, shippingCost, orderTotal } = estimate;
  invariant(
    Number.isSafeInteger(quantity) && quantity > 0 && quantity <= MAX_QUANTITY,
    "Order quantity must be a positive integer within the supported range.",
  );
  assertAllocations(quantity, allocations);
  invariant(
    estimate.merchandiseSubtotal.toDecimal().equals(UNIT_PRICE.times(quantity)),
    "Merchandise subtotal must equal quantity times unit price.",
  );
  invariant(
    estimate.merchandiseSubtotal
      .minus(estimate.discountAmount)
      .equals(estimate.discountedMerchandiseTotal),
    "Discounted merchandise total must equal subtotal minus discount.",
  );
  invariant(
    isShippingWithinLimit(shippingCost, estimate.discountedMerchandiseTotal),
    "Shipping cost exceeds 15% of the discounted merchandise total.",
  );
  invariant(
    estimate.discountedMerchandiseTotal.plus(shippingCost).equals(orderTotal),
    "Order total must equal discounted merchandise total plus shipping.",
  );

  return Object.freeze({
    id,
    orderNumber,
    quantity,
    destination: estimate.destination,
    merchandiseSubtotal: estimate.merchandiseSubtotal,
    discountRate: estimate.discountRate,
    discountAmount: estimate.discountAmount,
    discountedMerchandiseTotal: estimate.discountedMerchandiseTotal,
    shippingCost,
    orderTotal,
    allocations: Object.freeze(
      [...allocations].map((a) => Object.freeze({ ...a })),
    ) as ShippingPlan,
  });
}
