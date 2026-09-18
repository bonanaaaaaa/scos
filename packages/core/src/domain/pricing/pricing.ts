import { DomainDecimal } from "../shared/decimal";
import { Money } from "../shared/money";
import { UNIT_PRICE } from "../shared/product";
import type { Quantity } from "../shared/quantity";

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
