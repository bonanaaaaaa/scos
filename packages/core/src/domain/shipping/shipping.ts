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

import type { WarehouseAllocation } from "./allocation";

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

/**
 * The limit as published to clients: the exact limit truncated toward zero to
 * cents.
 *
 * Truncation, not half-up rounding, is what makes a client's own
 * `shippingCost <= shippingLimit` check agree with the server in every case.
 * A shipping cost is at cent scale, so for an exact limit L and its truncation
 * T = floor(L x 100) / 100, `cost <= L` holds exactly when `cost <= T`:
 * truncating discards only the amounts strictly between T and L, and no
 * two-decimal amount lies there. Half-up rounding does not have that property:
 * it can round the limit UP past an amount the server rejects. 15% of 150.05
 * is 22.5075, which rounds to 22.51 and would admit shipping of 22.51, while
 * the server rejects it. Truncation gives 22.50, which the server accepts.
 *
 * The published limit is advisory: {@link isShippingWithinLimit} still decides
 * against the exact, unrounded limit.
 *
 * The sub-cent digits this discards do not arise from a real order: with a
 * $150 unit price and whole-percent tiers every discounted merchandise total
 * is a multiple of $7.50, so its exact 15% has at most three decimals. The
 * function still takes any Money, and its tests cover a four-decimal limit
 * (15% of 1500.01), because nothing here should depend on the current price
 * or tiers.
 */
export function publishedShippingLimitFor(discountedMerchandiseTotal: Money): Money {
  return Money.fromDecimal(
    shippingLimitFor(discountedMerchandiseTotal).toDecimalPlaces(2, DomainDecimal.ROUND_DOWN),
  );
}

/** Rounded shipping at or below the exact limit is valid; equality passes. */
export function isShippingWithinLimit(
  shippingCost: Money,
  discountedMerchandiseTotal: Money,
): boolean {
  return shippingCost.toDecimal().lessThanOrEqualTo(shippingLimitFor(discountedMerchandiseTotal));
}
