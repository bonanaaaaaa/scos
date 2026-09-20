/**
 * Domain service: Shipping.
 *
 * Stateless business rules for the combined shipping charge and the limit
 * that shipping may not exceed 15% of the discounted merchandise total.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { type Decimal, DomainDecimal } from "#domain/shared/decimal";
import { Money } from "#domain/shared/money";
import {
  SHIPPING_LIMIT_RATIO,
  SHIPPING_RATE_PER_KG_KM,
  UNIT_WEIGHT_KG,
} from "#domain/shared/product";
import type { WarehouseAllocation } from "#domain/shipping/allocation";

/** Exact, unrounded sum of units x 0.365 kg x $0.01/kg/km x distance. */
export function unroundedShippingCost(allocations: readonly WarehouseAllocation[]): Decimal {
  const perUnitKm = UNIT_WEIGHT_KG.times(SHIPPING_RATE_PER_KG_KM);
  return allocations.reduce(
    (sum, allocation) =>
      sum.plus(
        perUnitKm
          .times(allocation.quantity)
          .times(new DomainDecimal(String(allocation.distanceKm))),
      ),
    new DomainDecimal(0),
  );
}

/** Combined shipping cost, rounded once to cents half-up. */
export function shippingCostFor(allocations: readonly WarehouseAllocation[]): Money {
  return Money.roundToCents(unroundedShippingCost(allocations));
}

/** Exact 15% of the discounted merchandise total (not rounded). */
export function shippingLimitFor(discountedMerchandiseTotal: Money): Decimal {
  return discountedMerchandiseTotal.toDecimal().times(SHIPPING_LIMIT_RATIO);
}

/** Rounded shipping at or below the exact limit is valid; equality passes. */
export function isShippingWithinLimit(
  shippingCost: Money,
  discountedMerchandiseTotal: Money,
): boolean {
  return shippingCost.toDecimal().lessThanOrEqualTo(shippingLimitFor(discountedMerchandiseTotal));
}
