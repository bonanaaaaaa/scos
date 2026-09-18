import type { WarehouseAllocation } from "./allocation.js";
import { type Decimal, DomainDecimal } from "./decimal.js";
import { Money } from "./money.js";
import {
  SHIPPING_LIMIT_RATIO,
  SHIPPING_RATE_PER_KG_KM,
  UNIT_PRICE,
  UNIT_WEIGHT_KG,
} from "./product.js";
import type { Quantity } from "./quantity.js";

export type DiscountRate = "0.00" | "0.05" | "0.10" | "0.15" | "0.20";

export interface DiscountTier {
  readonly minimumQuantity: number;
  readonly rate: DiscountRate;
}

/** Volume discount tiers, highest threshold first. */
export const DISCOUNT_TIERS: readonly DiscountTier[] = Object.freeze([
  Object.freeze({ minimumQuantity: 250, rate: "0.20" }),
  Object.freeze({ minimumQuantity: 100, rate: "0.15" }),
  Object.freeze({ minimumQuantity: 50, rate: "0.10" }),
  Object.freeze({ minimumQuantity: 25, rate: "0.05" }),
  Object.freeze({ minimumQuantity: 0, rate: "0.00" }),
] satisfies DiscountTier[]);

/** The highest qualifying tier's rate, applied to the whole subtotal. */
export function discountRateFor(quantity: number): DiscountRate {
  const tier = DISCOUNT_TIERS.find((candidate) => quantity >= candidate.minimumQuantity);
  return tier?.rate ?? "0.00";
}

export interface MerchandisePricing {
  readonly merchandiseSubtotal: Money;
  readonly discountRate: DiscountRate;
  readonly discountAmount: Money;
  readonly discountedMerchandiseTotal: Money;
}

/**
 * Prices merchandise exactly. With a $150 unit price and whole-percent rates
 * the discount is always a whole multiple of $0.05, so every amount is exact
 * at cent scale; Money construction asserts this instead of rounding.
 */
export function priceMerchandise(quantity: Quantity): MerchandisePricing {
  const discountRate = discountRateFor(quantity);
  const subtotal = UNIT_PRICE.times(quantity);
  const discount = subtotal.times(new DomainDecimal(discountRate));
  return Object.freeze({
    merchandiseSubtotal: Money.fromDecimal(subtotal),
    discountRate,
    discountAmount: Money.fromDecimal(discount),
    discountedMerchandiseTotal: Money.fromDecimal(subtotal.minus(discount)),
  });
}

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
