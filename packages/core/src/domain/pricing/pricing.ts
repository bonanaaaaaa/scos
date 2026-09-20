/**
 * Domain service with a policy: Pricing.
 *
 * Stateless merchandise pricing. The volume discount tiers are a business
 * policy expressed as data, applied to the whole subtotal.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { DomainDecimal } from "#domain/shared/decimal";
import { Money } from "#domain/shared/money";
import { UNIT_PRICE } from "#domain/shared/product";
import type { Quantity } from "#domain/shared/quantity";

export type DiscountRate = "0.00" | "0.05" | "0.10" | "0.15" | "0.20";

export interface DiscountTier {
  readonly minimumQuantity: number;
  readonly rate: DiscountRate;
}

/** The rate for a quantity below every discount tier. */
const NO_DISCOUNT_RATE: DiscountRate = "0.00";

/**
 * Volume discount tiers, highest threshold first. A quantity below the lowest
 * threshold gets {@link NO_DISCOUNT_RATE}.
 */
export const DISCOUNT_TIERS: readonly DiscountTier[] = Object.freeze([
  Object.freeze({ minimumQuantity: 250, rate: "0.20" }),
  Object.freeze({ minimumQuantity: 100, rate: "0.15" }),
  Object.freeze({ minimumQuantity: 50, rate: "0.10" }),
  Object.freeze({ minimumQuantity: 25, rate: "0.05" }),
] satisfies DiscountTier[]);

/** The highest qualifying tier's rate, applied to the whole subtotal. */
export function discountRateFor(quantity: Quantity): DiscountRate {
  const tier = DISCOUNT_TIERS.find((candidate) => quantity >= candidate.minimumQuantity);
  return tier?.rate ?? NO_DISCOUNT_RATE;
}

export interface MerchandisePricing {
  /** The price per unit the subtotal was calculated with. */
  readonly unitPrice: Money;
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
    unitPrice: Money.fromDecimal(UNIT_PRICE),
    merchandiseSubtotal: Money.fromDecimal(subtotal),
    discountRate,
    discountAmount: Money.fromDecimal(discount),
    discountedMerchandiseTotal: Money.fromDecimal(subtotal.minus(discount)),
  });
}
